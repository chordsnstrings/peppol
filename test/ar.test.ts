import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { outstandingMinor, isReceivable, paymentState, arSummary } from "@/lib/domain/ar";
import { invoice } from "./helpers";

/**
 * Who is signed in for the route calls at the foot of this file. Hoisted
 * because `vi.mock` is, and read on every call rather than captured, so a test
 * can change seats between two requests.
 */
const seat = vi.hoisted(() => ({ orgId: "", userId: "" }));

vi.mock("@/lib/server/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/session")>();
  return { ...actual, requireSession: async () => ({ orgId: seat.orgId, userId: seat.userId }) };
});

/**
 * The store route's session, not just the person in it: `requireWritableSession`
 * reads the impersonation cookie, and `cookies()` outside a request throws.
 * `isOrgWritable`, which the send pipeline calls, is left as the real one.
 */
vi.mock("@/lib/server/org-status", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/org-status")>();
  return { ...actual, requireWritableSession: async () => ({ orgId: seat.orgId, userId: seat.userId }) };
});

import { POST as storePost } from "@/app/api/store/[store]/route";
import { runSendPipeline } from "@/lib/server/send";
import { openBooks, openFiscalYear } from "@/lib/server/ledger/setup";
import { createCounterparty } from "@/lib/server/ledger/counterparties";
import { setCreditLimit } from "@/lib/server/ledger/credit-control";
import { postInvoice } from "@/lib/server/ledger/ar";
import { seedBuiltInRoles, assignRole } from "@/lib/server/ledger/permissions";
import type { InboundRecord } from "@/lib/server/inbound";
import type { Entity, Invoice, InvoiceEvent } from "@/lib/domain/types";

describe("outstandingMinor", () => {
  it("is total minus paid, floored at zero", () => {
    const inv = invoice({ amountPaidMinor: 40000 }); // total 52500 (1 line 50000 + 5% vat)
    expect(outstandingMinor(inv)).toBe(inv.totals.taxInclusiveMinor - 40000);
    expect(outstandingMinor(invoice({ amountPaidMinor: 999999 }))).toBe(0);
  });
});

describe("isReceivable", () => {
  it("only for sent, unpaid, outbound invoices", () => {
    expect(isReceivable(invoice({ lifecycleStatus: "SENT" }))).toBe(true);
    expect(isReceivable(invoice({ lifecycleStatus: "DRAFT" }))).toBe(false);
    expect(isReceivable(invoice({ lifecycleStatus: "SENT", paymentStatus: "PAID" }))).toBe(false);
    expect(isReceivable(invoice({ lifecycleStatus: "SENT", direction: "INBOUND" }))).toBe(false);
  });
});

describe("paymentState", () => {
  it("marks past-due invoices overdue", () => {
    expect(paymentState(invoice({ paymentStatus: "PAID" }))).toBe("PAID");
    expect(paymentState(invoice({ dueDate: "2000-01-01" }))).toBe("OVERDUE");
    expect(paymentState(invoice({ dueDate: "2999-01-01" }))).toBe("DUE");
  });
});

describe("arSummary", () => {
  it("sums outstanding across receivables and buckets the overdue ones", () => {
    const s = arSummary([
      invoice({ lifecycleStatus: "SENT", dueDate: "2000-01-01" }), // long overdue
      invoice({ lifecycleStatus: "SENT", dueDate: "2999-01-01" }), // not due
      invoice({ lifecycleStatus: "DRAFT" }), // not a receivable
    ]);
    expect(s.receivables).toHaveLength(2);
    expect(s.outstandingMinor).toBeGreaterThan(0);
    expect(s.overdueMinor).toBeGreaterThan(0);
    // the 90+ bucket should have caught the long-overdue one
    expect(s.buckets.find((b) => b.key === "90+")!.count).toBe(1);
    expect(s.buckets.find((b) => b.key === "current")!.count).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* The two doors onto a receivable                                     */
/* ------------------------------------------------------------------ */

/**
 * Everything above computes from a document already in the store. These are
 * about how it gets there and how it leaves, and both were open.
 *
 * The document store is a write-anything JSON sink: it sanitises what a client
 * posts to `invoices` and sanitised nothing on `inbound`, so a tenant could
 * post over a supplier's arrival and set `decision.transmitted` — a business
 * able to show it had rejected an invoice and told the supplier so, when
 * nothing had been sent to anybody. And it let a client write `READY`, which is
 * the state the credit gate guards, onto its own invoice.
 *
 * The gate itself bound at one door out of six. `ledger-credit-gate.test.ts`
 * proves what the gate decides; these prove that a send goes through it — the
 * paths that never finalise (bulk send, create-and-send, the fix-it queue, the
 * recurring runner, the public API) all pass through `runSendPipeline`, so that
 * is where it is checked from here.
 */

const db = new PrismaClient();
const d = process.env.DATABASE_URL ? describe : describe.skip;

const ORG = "t-org-ar-doors";
const ENT = "t-ent-ar-doors";
const NADIA = "u-ar-nadia"; // Bookkeeper: raises invoices, may not release a credit hold.
const SALIM = "u-ar-salim"; // Approver: holds the credit grant and nothing that raises a sale.

/** Sign in as somebody in the workspace under test. */
function as(userId: string) {
  seat.orgId = ORG;
  seat.userId = userId;
}

async function wipe() {
  for (const t of ["CreditHold", "CreditLimit", "Counterparty", "Transmission", "UsageEvent", "Record"]) {
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
    db.$executeRawUnsafe(`DELETE FROM "RoleAssignment" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "AccountingRole" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "Membership" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "OrgBilling" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "User" WHERE id IN ('${NADIA}', '${SALIM}')`),
    db.$executeRawUnsafe(`DELETE FROM "Organization" WHERE id = '${ORG}'`),
  ]);
}

/** POST a record the way the browser data layer does. */
async function storeWrite(store: string, body: unknown) {
  const res = await storePost(
    new Request(`http://localhost/api/store/${store}`, { method: "POST", body: JSON.stringify(body) }),
    { params: Promise.resolve({ store }) },
  );
  return { status: res.status, body: (await res.json()) as { error?: string; item?: Record<string, unknown> } };
}

const storedRow = async <T>(store: string, id: string): Promise<T | null> => {
  const row = await db.record.findUnique({ where: { store_id: { store, id } } });
  return row ? (JSON.parse(row.data) as T) : null;
};

/** Write a record as the server does — straight past the sanitizer, as `putRecord` goes. */
async function seedRecord(store: string, id: string, data: object, entityId?: string) {
  await db.record.create({
    data: { id, orgId: ORG, store, entityId: entityId ?? null, data: JSON.stringify({ ...data, orgId: ORG }) },
  });
}

/** The sending entity, on the simulator: a sandbox deployment is what every test here runs on. */
const THE_ENTITY: Omit<Entity, "orgId"> = {
  id: ENT,
  legalNameEn: "Our Company",
  trn: "100123456700003",
  vatRegistered: true,
  taxGroup: false,
  address: { country: "AE" },
  defaultCurrency: "AED",
  einvoicingStatus: "SANDBOX",
  emaratLinked: false,
  numberingPrefix: "INV",
  numberingSeq: 1,
  activationChecklist: { detailsComplete: true, sandboxTestSent: false, emaratConfirmed: false, agreementAccepted: false },
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

/** An arrival as `receiveInboundDocument` leaves it: simulated, unanswered, with its evidence. */
function arrival(id: string): InboundRecord {
  return {
    id,
    orgId: ORG,
    entityId: ENT,
    senderName: "Gulf Fabrication LLC",
    senderParticipantId: "0235:1009988776",
    receiverParticipantId: "0235:9911223344",
    docTypeId: "urn:peppol:pint:billing-1@ae-1",
    totalMinor: 52_500,
    currency: "AED",
    status: "VALID",
    buyerAction: "NONE",
    receivedAt: "2026-03-02T09:00:00.000Z",
    gatewayRef: "MOCK-DELIVERY-1",
    simulated: true,
    xml: "<Invoice><cbc:ID>SUP-1</cbc:ID></Invoice>",
    xmlSha256: "a".repeat(64),
    note: "This document was produced by this deployment's simulated gateway driver.",
    invoice: { number: "SUP-1", issueDate: "2026-03-01", currency: "AED" },
  };
}

let docSeq = 0;

/** A document that passes validation, so a refusal in the pipeline is never the document's fault. */
function doc(over: Partial<Invoice>): Invoice {
  const net = 100_000;
  const vat = 5_000;
  return {
    id: `ar-door-${++docSeq}`,
    orgId: ORG,
    entityId: ENT,
    direction: "OUTBOUND",
    docType: "TAX_INVOICE",
    number: `INV-D${docSeq}`,
    issueDate: "2026-03-01",
    supplyDate: "2026-03-01",
    dueDate: "2026-03-31",
    currency: "AED",
    customerId: "MARINA",
    buyer: { nameEn: "Marina Works LLC", trn: "100999888700003", address: { country: "AE" } },
    seller: { nameEn: "Our Company", trn: "100123456700003", address: { country: "AE" } },
    lines: [
      {
        id: `ln${docSeq}`, lineNo: 1, description: "Hull survey", qty: 1, unitCode: "C62",
        unitPriceMinor: net, taxProfileCode: "STANDARD_5", lineNetMinor: net, lineVatMinor: vat,
      },
    ],
    totals: { taxExclusiveMinor: net, vatMinor: vat, taxInclusiveMinor: net + vat, payableMinor: net + vat, perCategory: [] },
    lifecycleStatus: "DRAFT",
    exchangeStatus: "NOT_SENT",
    reportingStatusC2: "NOT_REPORTED",
    source: "EDITOR",
    compliance: { taxableEventDate: "2026-03-01", daysRemaining: 14, breached: false },
    createdAt: "2026-03-01T00:00:00Z",
    updatedAt: "2026-03-01T00:00:00Z",
    ...over,
  };
}

/** The document's own timeline, read back by type — the store returns rows in no order of its own. */
async function timelineOf(invoiceId: string) {
  const rows = await db.record.findMany({ where: { orgId: ORG, store: "invoiceEvents", invoiceId } });
  return rows.map((r) => JSON.parse(r.data) as InvoiceEvent);
}

d("what a tenant may write onto a record it holds", () => {
  beforeAll(async () => {
    await wipe();
    as(NADIA);
    await seedRecord("entities", ENT, THE_ENTITY, ENT);
  });
  afterAll(async () => {
    await wipe();
  });

  it("takes nothing but the buyer's own action from a posted inbound record", async () => {
    const original = arrival("in-forge-1");
    await seedRecord("inbound", original.id, original, ENT);

    // Every field the receiving corner owns, rewritten at once — with the one
    // that matters first: a rejection this deployment never transmitted,
    // claiming it was, on a document it says no simulator produced.
    const { status } = await storeWrite("inbound", {
      ...original,
      buyerAction: "ACKNOWLEDGED",
      senderName: "Somebody Else Entirely",
      senderParticipantId: "0235:0000000000",
      receiverParticipantId: "0235:0000000000",
      docTypeId: "urn:not:a:real:type",
      totalMinor: 1,
      currency: "USD",
      status: "HAS_ISSUES",
      issues: ["invented"],
      receivedAt: "1999-01-01T00:00:00.000Z",
      gatewayRef: "MOCK-DELIVERY-OTHER",
      simulated: false,
      note: undefined,
      xml: "<Invoice><cbc:ID>NOT-THE-DOCUMENT</cbc:ID></Invoice>",
      xmlSha256: "b".repeat(64),
      decision: {
        outcome: "REJECTED", reason: "Priced wrong", decidedAt: "2026-03-03T00:00:00.000Z",
        decidedBy: NADIA, transmitted: true, simulated: false, receiptRef: "REC-INVENTED",
      },
    });

    expect(status).toBe(200);
    const after = (await storedRow<InboundRecord>("inbound", original.id))!;
    // The buyer's own state is theirs to write; nothing else moved.
    expect(after.buyerAction).toBe("ACKNOWLEDGED");
    expect(after.decision).toBeUndefined();
    expect(after.simulated).toBe(true);
    expect(after.gatewayRef).toBe("MOCK-DELIVERY-1");
    expect(after.senderName).toBe("Gulf Fabrication LLC");
    expect(after.senderParticipantId).toBe("0235:1009988776");
    expect(after.receiverParticipantId).toBe("0235:9911223344");
    expect(after.docTypeId).toBe(original.docTypeId);
    expect(after.totalMinor).toBe(original.totalMinor);
    expect(after.currency).toBe("AED");
    expect(after.status).toBe("VALID");
    expect(after.issues).toBeUndefined();
    expect(after.receivedAt).toBe(original.receivedAt);
    expect(after.xml).toBe(original.xml);
    expect(after.xmlSha256).toBe(original.xmlSha256);
    expect(after.note).toBe(original.note);
  });

  it("keeps the action it had when the posted one is not an action", async () => {
    const original = arrival("in-forge-2");
    await seedRecord("inbound", original.id, { ...original, buyerAction: "EXPORTED" }, ENT);

    const { status } = await storeWrite("inbound", { ...original, buyerAction: "TRANSMITTED" });
    expect(status).toBe(200);
    expect((await storedRow<InboundRecord>("inbound", original.id))!.buyerAction).toBe("EXPORTED");
  });

  it("refuses to create an inbound document at all — nobody delivered it", async () => {
    const invented = arrival("in-invented");
    const { status, body } = await storeWrite("inbound", invented);
    expect(status).toBe(403);
    expect(body.error).toContain("delivered to you");
    expect(await storedRow("inbound", invented.id)).toBeNull();
  });

  it("will not let a client finalise its own invoice, and saves the edit anyway", async () => {
    const draft = doc({ id: "ar-store-ready", number: "INV-S1" });
    await seedRecord("invoices", draft.id, draft, ENT);

    // What the editor posts, plus the one field it has no business writing:
    // READY is where the credit limit is checked, so a client that could write
    // it could sell to a customer nobody may sell to.
    const { status } = await storeWrite("invoices", {
      ...draft,
      notes: "Agreed with the yard on the 2nd",
      lifecycleStatus: "READY",
      lockedAt: "2026-03-02T00:00:00.000Z",
    });

    expect(status).toBe(200);
    const after = (await storedRow<Invoice>("invoices", draft.id))!;
    expect(after.lifecycleStatus).toBe("DRAFT");
    expect(after.lockedAt).toBeUndefined();
    // Refusing the transition must not cost somebody the lines they just typed.
    expect(after.notes).toBe("Agreed with the yard on the 2nd");
  });

  it("lets a finalised invoice round-trip through the editor without being demoted", async () => {
    // Finalisation writes READY and `lockedAt` from the gated route. Editing
    // the document afterwards must not undo it as a side effect — and must not
    // let the client move the moment it was locked either.
    const ready = doc({ id: "ar-store-locked", number: "INV-S2", lifecycleStatus: "READY", lockedAt: "2026-03-02T00:00:00.000Z" });
    await seedRecord("invoices", ready.id, ready, ENT);

    const { status } = await storeWrite("invoices", {
      ...ready,
      notes: "Purchase order number added",
      lockedAt: "2026-03-09T00:00:00.000Z",
      paymentStatus: "PAID",
      amountPaidMinor: 105_000,
      exchangeStatus: "DELIVERED",
    });

    expect(status).toBe(200);
    const after = (await storedRow<Invoice>("invoices", ready.id))!;
    expect(after.lifecycleStatus).toBe("READY");
    expect(after.lockedAt).toBe("2026-03-02T00:00:00.000Z");
    expect(after.notes).toBe("Purchase order number added");
    // The pins that were already here, held: payment and transmission state
    // come from the server pipelines and from nowhere else.
    expect(after.paymentStatus).toBeUndefined();
    expect(after.amountPaidMinor).toBeUndefined();
    expect(after.exchangeStatus).toBe("NOT_SENT");
  });
});

d("the credit gate at the door every send goes through", () => {
  beforeAll(async () => {
    await wipe();
    as(NADIA);

    // A workspace that has configured roles, because a workspace that has not
    // allows everything — and the separation the override rests on is invisible
    // in that state.
    await db.organization.create({ data: { id: ORG, name: "Doors LLC", slug: ORG } });
    for (const [id, name, email] of [
      [NADIA, "Nadia", "nadia.ar@test.ae"],
      [SALIM, "Salim", "salim.ar@test.ae"],
    ] as const) {
      await db.user.create({ data: { id, name, email, passwordHash: "x" } });
      await db.membership.create({ data: { userId: id, orgId: ORG, role: "MEMBER" } });
    }
    await seedBuiltInRoles({ orgId: ORG });
    await assignRole({ orgId: ORG, userId: NADIA, roleCode: "BOOKKEEPER" });
    await assignRole({ orgId: ORG, userId: SALIM, roleCode: "APPROVER" });

    // Entitled to transmit: the paywall stands in front of everything below and
    // would otherwise answer first.
    await db.orgBilling.create({
      data: { orgId: ORG, subStatus: "active", subTier: "ANNUAL", currentPeriodEnd: new Date("2099-01-01") },
    });

    await seedRecord("entities", ENT, THE_ENTITY, ENT);

    await openFiscalYear({ orgId: ORG, entityId: ENT, label: "2026", startsOn: "2026-01-01" });
    await openBooks({ orgId: ORG, entityId: ENT });
    await createCounterparty({
      orgId: ORG, entityId: ENT,
      counterparty: { code: "MARINA", name: "Marina Works LLC", kind: "CUSTOMER", paymentTerms: 30 },
    });
    await setCreditLimit({
      orgId: ORG, entityId: ENT, partyKey: "MARINA", limitMinor: 200_000n, effectiveFrom: "2026-01-01",
      basis: "One year of trade, references taken", actorId: NADIA,
    });
    /* 105,000 already on the sales ledger, so the next 105,000 is 10,000 too
     * far. It goes into the store as well as onto the books, because the
     * ageing files a movement under a customer by reading the document it came
     * from — an entry whose invoice is not there is attributed to nobody. */
    const open = doc({ id: "ar-open", number: "INV-OPEN", lifecycleStatus: "SENT" });
    await seedRecord("invoices", open.id, open, ENT);
    await postInvoice({ orgId: ORG, invoice: open });
  });
  afterAll(async () => {
    await wipe();
    await db.$disconnect();
  });

  it("refuses a draft that would take the customer past their limit, whichever screen asked", async () => {
    const draft = doc({ id: "ar-send-refused", number: "INV-R1" });
    await seedRecord("invoices", draft.id, draft, ENT);

    const outcome = await runSendPipeline(ORG, draft.id, { actorId: NADIA });

    expect(outcome.ok).toBe(false);
    expect(outcome.status).toBe(409);
    // A refusal that says only "refused" sends the salesperson to accounts and
    // accounts back to the salesperson. These four are the argument itself.
    expect(outcome.error).toContain("INV-R1 was not sent");
    expect(outcome.error).toContain("AED 2,000.00"); // the limit
    expect(outcome.error).toContain("AED 1,050.00"); // what they carry
    expect(outcome.error).toContain("AED 2,100.00"); // where this takes them
    expect(outcome.error).toContain("ar.credit_hold"); // and who may let it through

    // Nothing moved: not the document, not the gateway.
    const after = (await storedRow<Invoice>("invoices", draft.id))!;
    expect(after.lifecycleStatus).toBe("DRAFT");
    expect(after.exchangeStatus).toBe("NOT_SENT");
    expect(await db.transmission.findFirst({ where: { orgId: ORG, invoiceId: draft.id } })).toBeNull();
  });

  it("does not check a document that has already been finalised through the gate", async () => {
    // The screen finalises first and then sends. Checking again here would
    // refuse the same sale twice — the second time in a place with no override
    // — including one somebody has already put their name to.
    const ready = doc({ id: "ar-send-ready", number: "INV-R2", lifecycleStatus: "READY", lockedAt: "2026-03-02T00:00:00.000Z" });
    await seedRecord("invoices", ready.id, ready, ENT);

    const outcome = await runSendPipeline(ORG, ready.id, { actorId: NADIA });

    expect(outcome.status).not.toBe(409);
    // It got as far as the network preflight, which is where a buyer with no
    // Peppol id stops — past the gate, and past validation.
    expect(outcome.ok).toBe(true);
    expect(outcome.blocked).toBe("NOT_ON_NETWORK");
  });

  it("will not send a cancelled document, which is also how a refusal would be walked around", async () => {
    // Cancelling is a move a client may make on its own record. A draft the
    // gate refused could otherwise be cancelled and then sent, arriving in a
    // state the gate does not read.
    const abandoned = doc({ id: "ar-send-cancelled", number: "INV-R6", lifecycleStatus: "CANCELLED" });
    await seedRecord("invoices", abandoned.id, abandoned, ENT);

    const outcome = await runSendPipeline(ORG, abandoned.id, { actorId: NADIA });

    expect(outcome.ok).toBe(false);
    expect(outcome.status).toBe(422);
    expect(outcome.error).toContain("was cancelled");
    expect((await storedRow<Invoice>("invoices", abandoned.id))!.exchangeStatus).toBe("NOT_SENT");
  });

  it("will not take an override from a caller that names nobody", async () => {
    const draft = doc({ id: "ar-send-keyed", number: "INV-R3" });
    await seedRecord("invoices", draft.id, draft, ENT);

    // An API key authenticates a workspace, not a person, and an override
    // nobody can be held to is not an override.
    const outcome = await runSendPipeline(ORG, draft.id, { creditOverrideReason: "Cash on delivery agreed" });

    expect(outcome.ok).toBe(false);
    expect(outcome.status).toBe(403);
    expect(outcome.error).toContain("nobody to hold");
    expect(outcome.error).toContain("ar.credit_hold");
    // The sale is still stopped for the reason it was stopped for.
    expect(outcome.error).toContain("AED 2,000.00");
    expect(await timelineOf(draft.id)).toEqual([]);
  });

  it("will not let the person who raised the invoice clear their own refusal", async () => {
    const draft = doc({ id: "ar-send-bookkeeper", number: "INV-R4" });
    await seedRecord("invoices", draft.id, draft, ENT);

    // Nadia may raise invoices and post them. Releasing a credit hold is
    // somebody else's grant, and that separation is the whole of the control.
    const outcome = await runSendPipeline(ORG, draft.id, {
      actorId: NADIA,
      creditOverrideReason: "Cash on delivery agreed with the customer",
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.status).toBe(403);
    expect(outcome.error).toContain("Place and release credit holds");
    // Told what she may not do AND why the sale was stopped — replacing the
    // credit refusal with an access refusal would lose the grounds.
    expect(outcome.error).toContain("over their limit");
    expect((await storedRow<Invoice>("invoices", draft.id))!.lifecycleStatus).toBe("DRAFT");
    expect(await timelineOf(draft.id)).toEqual([]);
  });

  it("sends on an override by somebody who holds the grant, and puts the figures on the timeline", async () => {
    const draft = doc({ id: "ar-send-overridden", number: "INV-R5" });
    await seedRecord("invoices", draft.id, draft, ENT);

    const outcome = await runSendPipeline(ORG, draft.id, {
      actorId: SALIM,
      creditOverrideReason: "Cash on delivery agreed with the customer",
    });

    // Past the gate. It stops at the preflight for want of a Peppol id, which
    // is a fact about the buyer's registration and not about their credit.
    expect(outcome.ok).toBe(true);
    expect(outcome.blocked).toBe("NOT_ON_NETWORK");

    const override = (await timelineOf(draft.id)).find((e) => e.type === "credit_override")!;
    expect(override).toBeTruthy();
    expect(override.actor).toBe(SALIM);
    expect(override.tone).toBe("warning");
    expect(override.detail).toContain("Cash on delivery agreed with the customer");
    // The figures travel with it: the check will answer differently by the time
    // anybody reads this back, because the exposure will have moved.
    expect(override.detail).toContain("AED 2,000.00");
    expect(override.detail).toContain("AED 1,050.00");
  });
});
