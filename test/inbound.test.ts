import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PrismaClient } from "@prisma/client";
import { mockGateway } from "@/lib/gateway/mock-gateway";
import { PINT_AE, type GatewayEvent, type InboundDocument } from "@/lib/gateway/port";
import { SIMULATED_SEND_NOTE } from "@/lib/gateway/disclosure";
import {
  pollInbound,
  readDocumentFacts,
  receiveInboundDocument,
  recordInboundDecision,
  markInboundExported,
  validateArrival,
  SIMULATED_ARRIVAL_NOTE,
  type InboundRecord,
} from "@/lib/server/inbound";

/**
 * Corner 4 — the receiving half.
 *
 * The defect these cover: the inbox screen read a store nothing ever wrote, so
 * a supplier's document reached the webhook, matched no transmission this org
 * had sent, and was dropped in silence. Every assertion below is about a
 * document ARRIVING rather than one going out, and the two that matter most are
 * that it lands in the right tenant's inbox and that a rejection nobody
 * transmitted never claims it was transmitted.
 */

const db = new PrismaClient();
const d = process.env.DATABASE_URL ? describe : describe.skip;

const ORG = "t-org-inbound";
const NEIGHBOUR = "t-org-inbound-neighbour";
const ENT = "t-ent-inbound";
/** Deliberately unlike anything another test file seeds — resolution scans every tenant. */
const PID = "0235:9911223344";
const SUPPLIER_PID = "0235:1009988776";

async function wipe() {
  await db.record.deleteMany({ where: { orgId: { in: [ORG, NEIGHBOUR] } } });
}

async function seedEntity(orgId: string, id: string, participantId: string) {
  const now = "2026-09-01T00:00:00.000Z";
  const entity = {
    id,
    orgId,
    legalNameEn: "Receiving Co LLC",
    trn: "100112233400003",
    peppolParticipantId: participantId,
    vatRegistered: true,
    taxGroup: false,
    defaultCurrency: "AED",
    einvoicingStatus: "SANDBOX",
    emaratLinked: false,
    numberingPrefix: "INV",
    numberingSeq: 1,
    activationChecklist: { detailsComplete: true, sandboxTestSent: false, emaratConfirmed: false, agreementAccepted: true },
    createdAt: now,
    updatedAt: now,
  };
  await db.record.create({
    data: { id, orgId, store: "entities", entityId: id, data: JSON.stringify(entity) },
  });
}

/** The one document the simulator delivers, as the port hands it over. */
async function sampleEvent(): Promise<Extract<GatewayEvent, { kind: "DOCUMENT_RECEIVED" }>> {
  const events = (await mockGateway.fetchInboundDocuments?.(PID)) ?? [];
  const event = events.find((e) => e.kind === "DOCUMENT_RECEIVED");
  if (!event || event.kind !== "DOCUMENT_RECEIVED") throw new Error("the mock delivered no inbound document");
  return event;
}

async function inboundRows(orgId: string): Promise<InboundRecord[]> {
  const rows = await db.record.findMany({ where: { orgId, store: "inbound" } });
  return rows.map((r) => JSON.parse(r.data) as InboundRecord);
}

describe("reading an arriving document", () => {
  it("reads the document's own account of itself out of the UBL", async () => {
    const event = await sampleEvent();
    const facts = readDocumentFacts(event.document.xml);

    expect(facts.root).toBe("Invoice");
    expect(facts.currency).toBe("AED");
    expect(facts.supplierName).toBe("Gulf Stationery Supplies LLC");
    expect(facts.supplierParticipantId).toBe(SUPPLIER_PID);
    // 4 × 45.00 + 3 × 26.00 = 258.00 net, 5% VAT = 12.90, payable 270.90.
    expect(facts.payableMinor).toBe(27090);
    expect(facts.number).toBe(event.document.number);
  });

  it("passes a document that agrees with its own envelope", async () => {
    const event = await sampleEvent();
    expect(validateArrival(event.document, readDocumentFacts(event.document.xml))).toEqual([]);
  });

  it("flags an envelope that disagrees with the document it carries", async () => {
    const event = await sampleEvent();
    const doc: InboundDocument = { ...event.document, totalMinor: 999_00, currency: "USD" };
    const issues = validateArrival(doc, readDocumentFacts(doc.xml));

    expect(issues.some((i) => i.includes("payable amount"))).toBe(true);
    expect(issues.some((i) => i.includes("USD"))).toBe(true);
  });

  it("flags a payload that is not a PINT AE billing document", async () => {
    const event = await sampleEvent();
    const doc: InboundDocument = { ...event.document, docTypeId: "urn:something:else", xml: "<html>not ubl</html>" };
    const issues = validateArrival(doc, readDocumentFacts(doc.xml));

    expect(issues.some((i) => i.includes("not a UBL"))).toBe(true);
    expect(issues.some((i) => i.includes("PINT AE"))).toBe(true);
  });

  it("flags a sender that is not a well-formed participant", async () => {
    const event = await sampleEvent();
    const doc: InboundDocument = { ...event.document, senderParticipantId: "not-a-peppol-id" };
    const issues = validateArrival(doc, readDocumentFacts(doc.xml));

    expect(issues.some((i) => i.includes("not a well-formed Peppol id"))).toBe(true);
  });
});

d("taking delivery", () => {
  beforeAll(async () => {
    await wipe();
    await seedEntity(ORG, ENT, PID);
  });
  afterAll(async () => {
    await wipe();
    await db.$disconnect();
  });
  beforeEach(async () => {
    await db.record.deleteMany({ where: { orgId: { in: [ORG, NEIGHBOUR] }, store: { in: ["inbound", "notifications"] } } });
    await db.record.deleteMany({ where: { orgId: NEIGHBOUR, store: "entities" } });
  });

  it("puts a document addressed to our participant into that entity's inbox", async () => {
    const event = await sampleEvent();
    const arrival = await receiveInboundDocument(event);

    expect(arrival.ok).toBe(true);
    expect(arrival.duplicate).toBeUndefined();

    const stored = await inboundRows(ORG);
    expect(stored).toHaveLength(1);
    const doc = stored[0];
    // The whole defect in one assertion: before this, nothing anywhere wrote
    // one of these, so the inbox had nothing it could ever show.
    expect(doc.entityId).toBe(ENT);
    expect(doc.senderParticipantId).toBe(SUPPLIER_PID);
    expect(doc.receiverParticipantId).toBe(PID);
    expect(doc.docTypeId).toBe(PINT_AE.invoiceDocTypeId);
    expect(doc.status).toBe("VALID");
    expect(doc.buyerAction).toBe("NONE");
    // The figure on the screen is the one in the document, not the envelope's.
    expect(doc.totalMinor).toBe(27090);
    expect(doc.currency).toBe("AED");
    expect(doc.xml).toContain("<cbc:PayableAmount");
    expect(doc.xmlSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("labels a document the simulator produced, and says so on the record", async () => {
    const arrival = await receiveInboundDocument(await sampleEvent());

    expect(arrival.doc?.simulated).toBe(true);
    expect(arrival.doc?.note).toBe(SIMULATED_ARRIVAL_NOTE);

    const notifications = await db.record.findMany({ where: { orgId: ORG, store: "notifications" } });
    expect(notifications).toHaveLength(1);
    const n = JSON.parse(notifications[0].data) as { title: string; body?: string; tone?: string };
    // "An invoice arrived from Gulf Stationery" about a document this deployment
    // wrote for itself is the receiving half of the sentence the send pipeline
    // refuses to print.
    expect(n.title).toContain("Simulated");
    expect(n.body).toBe(SIMULATED_ARRIVAL_NOTE);
    expect(n.tone).toBe("warning");
  });

  it("treats a redelivery of the same reference as the same document", async () => {
    const event = await sampleEvent();
    await receiveInboundDocument(event);
    const again = await receiveInboundDocument({ ...event, at: new Date().toISOString() });

    expect(again.ok).toBe(true);
    expect(again.duplicate).toBe(true);
    expect(await inboundRows(ORG)).toHaveLength(1);
  });

  it("reports a document for a participant nobody claims instead of dropping it", async () => {
    const event = await sampleEvent();
    const stray = { ...event, document: { ...event.document, receiverParticipantId: "0235:7777000011" } };
    const arrival = await receiveInboundDocument(stray);

    expect(arrival.ok).toBe(false);
    expect(arrival.reason).toContain("0235:7777000011");
    expect(await inboundRows(ORG)).toHaveLength(0);
  });

  it("refuses to guess when two entities claim the same participant", async () => {
    await seedEntity(NEIGHBOUR, "t-ent-inbound-neighbour", PID);
    const arrival = await receiveInboundDocument(await sampleEvent());

    expect(arrival.ok).toBe(false);
    expect(arrival.reason).toContain("ambiguous");
    expect(await inboundRows(ORG)).toHaveLength(0);
    expect(await inboundRows(NEIGHBOUR)).toHaveLength(0);
  });

  it("stores a document that disagrees with its envelope rather than discarding it", async () => {
    const event = await sampleEvent();
    const arrival = await receiveInboundDocument({
      ...event,
      document: { ...event.document, totalMinor: 100 },
    });

    expect(arrival.ok).toBe(true);
    expect(arrival.doc?.status).toBe("HAS_ISSUES");
    expect(arrival.doc?.issues?.length).toBeGreaterThan(0);
    // The recipient decides. A receiving corner that discards what it cannot
    // understand leaves the supplier believing it was received.
    expect(arrival.doc?.totalMinor).toBe(27090);
  });

  it("carries an inbound document through the mock's webhook parser", async () => {
    const event = await sampleEvent();
    const parsed = await mockGateway.parseWebhook({}, JSON.stringify(event));

    expect(parsed).toHaveLength(1);
    expect(parsed[0].kind).toBe("DOCUMENT_RECEIVED");
    expect(parsed[0].simulated).toBe(true);
  });

  it("polls the gateway once a day per participant", async () => {
    const first = await pollInbound(ORG, ENT);
    expect(first.ok).toBe(true);
    expect(first.received).toBe(1);
    expect(first.simulated).toBe(true);

    const second = await pollInbound(ORG, ENT);
    expect(second.received).toBe(0);
    expect(second.duplicates).toBe(1);
    expect(await inboundRows(ORG)).toHaveLength(1);
  });

  it("says why nothing can be addressed to an entity with no participant id", async () => {
    await db.record.create({
      data: {
        id: "t-ent-inbound-bare",
        orgId: ORG,
        store: "entities",
        entityId: "t-ent-inbound-bare",
        data: JSON.stringify({ id: "t-ent-inbound-bare", orgId: ORG, legalNameEn: "Bare", defaultCurrency: "AED" }),
      },
    });
    const outcome = await pollInbound(ORG, "t-ent-inbound-bare");

    expect(outcome.ok).toBe(false);
    expect(outcome.status).toBe(409);
    expect(outcome.error).toContain("no Peppol participant id");
    await db.record.deleteMany({ where: { orgId: ORG, store: "entities", id: "t-ent-inbound-bare" } });
  });
});

d("accepting and rejecting", () => {
  beforeAll(async () => {
    await wipe();
    await seedEntity(ORG, ENT, PID);
  });
  afterAll(async () => {
    await wipe();
    await db.$disconnect();
  });
  beforeEach(async () => {
    await db.record.deleteMany({ where: { orgId: ORG, store: { in: ["inbound", "notifications"] } } });
  });

  async function received(): Promise<InboundRecord> {
    const arrival = await receiveInboundDocument(await sampleEvent());
    if (!arrival.doc) throw new Error(arrival.reason ?? "nothing arrived");
    return arrival.doc;
  }

  it("records a rejection with its reason and never claims the supplier was told", async () => {
    const doc = await received();
    const outcome = await recordInboundDecision(ORG, doc.id, {
      outcome: "REJECTED",
      reason: "The goods on line 2 were never delivered.",
      actor: "t-user-inbound",
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.doc?.buyerAction).toBe("DISPUTED");
    const decision = outcome.doc?.decision;
    expect(decision?.outcome).toBe("REJECTED");
    expect(decision?.reason).toBe("The goods on line 2 were never delivered.");
    expect(decision?.decidedBy).toBe("t-user-inbound");
    // The mock answers the receipt with a reference it made up. Nothing left
    // this deployment, so `transmitted` stays false and the note says what the
    // screen is allowed to say about it.
    expect(decision?.simulated).toBe(true);
    expect(decision?.transmitted).toBe(false);
    expect(decision?.receiptRef).toMatch(/^MOCK-RCPT-/);
    expect(decision?.note).toBe(SIMULATED_SEND_NOTE);
  });

  it("refuses a rejection that says nothing", async () => {
    const doc = await received();
    const outcome = await recordInboundDecision(ORG, doc.id, { outcome: "REJECTED", reason: "   ", actor: "t-user-inbound" });

    expect(outcome.ok).toBe(false);
    expect(outcome.status).toBe(422);
    const stored = await inboundRows(ORG);
    expect(stored[0].decision).toBeUndefined();
    expect(stored[0].buyerAction).toBe("NONE");
  });

  it("records an acceptance without demanding a reason", async () => {
    const doc = await received();
    const outcome = await recordInboundDecision(ORG, doc.id, { outcome: "ACCEPTED", actor: "t-user-inbound" });

    expect(outcome.ok).toBe(true);
    expect(outcome.doc?.buyerAction).toBe("ACKNOWLEDGED");
    expect(outcome.doc?.decision?.outcome).toBe("ACCEPTED");
    expect(outcome.doc?.decision?.transmitted).toBe(false);
  });

  it("will not turn a rejection into an acceptance behind the supplier's back", async () => {
    const doc = await received();
    await recordInboundDecision(ORG, doc.id, { outcome: "REJECTED", reason: "Wrong TRN", actor: "t-user-inbound" });
    const flip = await recordInboundDecision(ORG, doc.id, { outcome: "ACCEPTED", actor: "t-user-inbound" });

    expect(flip.ok).toBe(false);
    expect(flip.status).toBe(409);
    const stored = await inboundRows(ORG);
    expect(stored[0].decision?.outcome).toBe("REJECTED");
  });

  it("keeps the original reason when the same decision is sent again", async () => {
    const doc = await received();
    await recordInboundDecision(ORG, doc.id, { outcome: "REJECTED", reason: "Wrong TRN", actor: "t-user-inbound" });
    const retry = await recordInboundDecision(ORG, doc.id, {
      outcome: "REJECTED",
      reason: "something else entirely",
      actor: "t-someone-else",
    });

    expect(retry.ok).toBe(true);
    expect(retry.doc?.decision?.reason).toBe("Wrong TRN");
    expect(retry.doc?.decision?.decidedBy).toBe("t-user-inbound");
  });

  it("marks an accepted document as taken into the books", async () => {
    const doc = await received();
    await recordInboundDecision(ORG, doc.id, { outcome: "ACCEPTED", actor: "t-user-inbound" });
    const outcome = await markInboundExported(ORG, doc.id);

    expect(outcome.ok).toBe(true);
    expect(outcome.doc?.buyerAction).toBe("EXPORTED");
    // The decision survives the marker: `buyerAction` holds one value at a time,
    // and the answer given to the supplier is not the kind of thing a filing
    // action may overwrite.
    expect(outcome.doc?.decision?.outcome).toBe("ACCEPTED");
  });

  it("does not take a rejected document into the books", async () => {
    const doc = await received();
    await recordInboundDecision(ORG, doc.id, { outcome: "REJECTED", reason: "Duplicate of INV-1", actor: "t-user-inbound" });
    const outcome = await markInboundExported(ORG, doc.id);

    expect(outcome.ok).toBe(false);
    expect(outcome.status).toBe(409);
    const stored = await inboundRows(ORG);
    expect(stored[0].buyerAction).toBe("DISPUTED");
  });

  it("does not decide on a document that is not in this tenant's inbox", async () => {
    const outcome = await recordInboundDecision(ORG, "in_nothing", { outcome: "ACCEPTED", actor: "t-user-inbound" });
    expect(outcome.ok).toBe(false);
    expect(outcome.status).toBe(404);
  });
});
