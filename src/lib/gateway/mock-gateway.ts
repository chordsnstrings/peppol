import { createHash } from "node:crypto";
import { computeTotals, recomputeLines } from "@/lib/domain/tax";
import { generateUBL } from "@/lib/domain/ubl";
import type { Invoice, InvoiceLine } from "@/lib/domain/types";
import { PINT_AE } from "./port";
import type {
  GatewayEvent,
  HealthStatus,
  ParticipantCapability,
  PeppolGatewayPort,
  ReceiptRequest,
  ReceiptResult,
  SubmitRequest,
  SubmitResult,
} from "./port";

/**
 * The document the simulator delivers to a participant that asks for its post.
 *
 * It is built by `generateUBL` from a real Invoice rather than kept as a fixture
 * string, so what the receiving path is exercised against is exactly the shape
 * this product puts on the network — a fixture would drift from the serializer
 * the first time BR-08 or a tax subtotal changed, and the receiver would then be
 * tested against a document nobody sends.
 *
 * One sample per participant per day: the reference is derived from the
 * participant and the date, so pressing the control twice on a Tuesday is one
 * delivery and a duplicate, not two invoices from a supplier who sent one.
 */
const SAMPLE_SUPPLIER_PARTICIPANT_ID = "0235:1009988776";

function sampleArrival(receiverParticipantId: string, at: Date): { gatewayRef: string; invoice: Invoice } {
  const day = at.toISOString().slice(0, 10);
  const seed = createHash("sha1").update(`inbound|${receiverParticipantId}|${day}`).digest("hex");
  const lines: InvoiceLine[] = recomputeLines([
    {
      id: `${seed.slice(0, 8)}-1`,
      lineNo: 1,
      description: "A4 copier paper — box of 5 reams",
      qty: 4,
      unitCode: "C62",
      unitPriceMinor: 4500,
      taxProfileCode: "STANDARD_5",
      lineNetMinor: 0,
      lineVatMinor: 0,
    },
    {
      id: `${seed.slice(0, 8)}-2`,
      lineNo: 2,
      description: "Whiteboard markers — pack of 12",
      qty: 3,
      unitCode: "C62",
      unitPriceMinor: 2600,
      taxProfileCode: "STANDARD_5",
      lineNetMinor: 0,
      lineVatMinor: 0,
    },
  ]);

  const invoice: Invoice = {
    id: `mock-inbound-${seed.slice(0, 12)}`,
    orgId: "",
    entityId: "",
    direction: "INBOUND",
    docType: "TAX_INVOICE",
    number: `GSS-${day.replace(/-/g, "")}-${seed.slice(0, 4).toUpperCase()}`,
    issueDate: day,
    supplyDate: day,
    currency: "AED",
    // The simulator knows the recipient by their participant id and by nothing
    // else — it has not looked anybody up — so that is what it writes as the
    // buyer, rather than inventing a company name for a real business.
    buyer: { nameEn: receiverParticipantId, peppolId: receiverParticipantId },
    seller: {
      nameEn: "Gulf Stationery Supplies LLC",
      trn: "100998877600003",
      peppolId: SAMPLE_SUPPLIER_PARTICIPANT_ID,
      address: { street: "Warehouse 4, Al Quoz Industrial 3", city: "Dubai", emirate: "DU", country: "AE" },
    },
    lines,
    totals: computeTotals(lines),
    lifecycleStatus: "SENT",
    exchangeStatus: "DELIVERED",
    reportingStatusC2: "ACCEPTED",
    source: "INGEST",
    compliance: { taxableEventDate: day, daysRemaining: 14, breached: false },
    createdAt: at.toISOString(),
    updatedAt: at.toISOString(),
  };

  return { gatewayRef: `MOCK-IN-${seed.slice(0, 16).toUpperCase()}`, invoice };
}

/**
 * In-process mock gateway (spec §5.6). Runs the full send pipeline with no
 * external calls: submit returns a ref and fetchStatusUpdates returns a terminal
 * ACCEPTED on both legs, so a sandbox send completes end-to-end. Configurable
 * failure can be added later via the mock-network simulator.
 *
 * Every event it emits carries `simulated: true`. That flag is the whole reason
 * the rest of the product can be honest about a rehearsal: this driver's
 * "ACCEPTED" is a value assigned in this file, not an acknowledgement from the
 * buyer's Access Point or the FTA, and an acceptance nobody sent is exactly the
 * thing a user must never be shown as fact.
 */
export const mockGateway: PeppolGatewayPort = {
  driver: "mock",

  async lookupParticipant(participantId: string): Promise<ParticipantCapability> {
    const onNetwork = /^\d{4}:\d{6,}$/.test(participantId);
    return {
      participantId,
      onNetwork,
      supportedDocTypes: ["PINT_AE_INVOICE", "PINT_AE_CREDIT_NOTE"],
      checkedAt: new Date().toISOString(),
    };
  },

  async submitDocument(req: SubmitRequest): Promise<SubmitResult> {
    const ref = "MOCK-" + createHash("sha1").update(req.idempotencyKey).digest("hex").slice(0, 16).toUpperCase();
    return { gatewayRef: ref };
  },

  async fetchStatusUpdates(gatewayRef: string): Promise<GatewayEvent[]> {
    const at = new Date().toISOString();
    return [
      { kind: "EXCHANGE_MLS", gatewayRef, status: "ACCEPTED", at, simulated: true },
      { kind: "REPORTING_MLS", gatewayRef, leg: "C2", status: "ACCEPTED", at, simulated: true },
    ];
  },

  async parseWebhook(_headers, rawBody: string): Promise<GatewayEvent[]> {
    try {
      const parsed = JSON.parse(rawBody);
      const events = (Array.isArray(parsed) ? parsed : [parsed]) as GatewayEvent[];
      // This driver verifies no signature, so anything that reaches it is a
      // hand-posted body. The flag is re-stamped here rather than trusted from
      // the payload: a caller must not be able to launder an event into looking
      // like a real one by leaving the field out.
      return events.map((e) => ({ ...e, simulated: true }));
    } catch {
      return [];
    }
  },

  /**
   * The receiving half, simulated. A deployment on the mock has no supplier
   * sending it anything, so the inbox is a screen that can never fill — and a
   * receiving corner nobody has ever seen work is a receiving corner nobody
   * knows is broken. This delivers one sample document so the whole path
   * (resolve the participant, validate, store, accept or reject) runs without
   * a network, flagged `simulated` like everything else this driver emits.
   */
  async fetchInboundDocuments(participantId: string): Promise<GatewayEvent[]> {
    const now = new Date();
    const { gatewayRef, invoice } = sampleArrival(participantId, now);
    return [
      {
        kind: "DOCUMENT_RECEIVED",
        gatewayRef,
        at: now.toISOString(),
        simulated: true,
        document: {
          senderParticipantId: SAMPLE_SUPPLIER_PARTICIPANT_ID,
          receiverParticipantId: participantId,
          docTypeId: PINT_AE.invoiceDocTypeId,
          xml: generateUBL(invoice),
          senderName: invoice.seller.nameEn,
          number: invoice.number,
          issueDate: invoice.issueDate,
          currency: invoice.currency,
          totalMinor: invoice.totals.payableMinor,
        },
      },
    ];
  },

  /**
   * A rehearsal of the answer going back to the supplier. Nothing leaves the
   * process, and the reference below is a value assigned in this file — which
   * is why `isSimulatedTransmission` and not the presence of this method is
   * what decides whether the product may say the supplier was told.
   */
  async sendReceipt(req: ReceiptRequest): Promise<ReceiptResult> {
    const ref = "MOCK-RCPT-" + createHash("sha1").update(req.idempotencyKey).digest("hex").slice(0, 16).toUpperCase();
    return { receiptRef: ref };
  },

  async healthcheck(): Promise<HealthStatus> {
    return { ok: true, detail: "mock gateway — simulated, reaches no network" };
  },
};
