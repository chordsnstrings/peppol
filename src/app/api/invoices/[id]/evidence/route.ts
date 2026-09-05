import { createHash } from "node:crypto";
import { requireSession } from "@/lib/server/session";
import { json, handleError } from "@/lib/server/http";
import { getRecord, listRecords } from "@/lib/server/store";
import { prisma } from "@/lib/server/prisma";
import { isSimulatedTransmission } from "@/lib/gateway/registry";
import { EVIDENCE_STATEMENT } from "@/lib/gateway/disclosure";
import { RECORD_RETENTION } from "@/lib/gateway/retention";
import type { Invoice, InvoiceEvent } from "@/lib/domain/types";

export const runtime = "nodejs";

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/**
 * Compliance evidence bundle for one invoice (spec §7.7): CIM snapshot + final
 * UBL + Tax Data Document + full event trail + a manifest with a SHA-256 of each
 * part. Downloadable so the SME can hand it to an FTA auditor.
 *
 * Because it is handed to an auditor, this route may only assert what it can
 * prove. A bundle for a document a simulator handled still gets built — the UBL
 * and the Tax Data Document are real artefacts, built by the same code a live
 * send uses, and they are worth having — but it is labelled a rehearsal at the
 * top and it does not repeat the simulator's DELIVERED/ACCEPTED as though a
 * counterparty had said it.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const { orgId } = await requireSession();

    const invoice = await getRecord<Invoice>(orgId, "invoices", id);
    if (!invoice) return json({ error: "Invoice not found" }, 404);

    const tx = await prisma.transmission.findFirst({
      where: { orgId, invoiceId: id },
      orderBy: { createdAt: "desc" },
    });
    const events = (await listRecords<InvoiceEvent>(orgId, "invoiceEvents", { invoiceId: id })).sort(
      (a, b) => a.at.localeCompare(b.at),
    );

    // Judged from the driver recorded ON THE ROW, never from the environment as
    // it stands today: a deployment that goes live next month must not start
    // describing last month's rehearsals as transmissions.
    const simulated = tx ? isSimulatedTransmission(tx.driver) : false;
    const status = !tx ? "NOT_SENT" : simulated ? "SIMULATED" : "TRANSMITTED";
    const statement = EVIDENCE_STATEMENT[status];

    const cim = JSON.stringify(invoice, null, 2);
    // The statement is also a part, and the first one, so it survives being
    // saved to disk and read without the manifest beside it.
    const parts: Record<string, string> = { "attestation.txt": `${status}\n\n${statement}\n`, "cim.json": cim };
    if (tx) {
      parts["invoice.ubl.xml"] = tx.ublXml;
      parts["tax-data-document.xml"] = tx.tddXml;
    }
    parts["timeline.json"] = JSON.stringify(events, null, 2);

    const manifest = {
      // First field in the manifest, because it governs how every field after
      // it may be read.
      attestation: { status, statement },
      invoiceNumber: invoice.number,
      docType: invoice.docType,
      entityId: invoice.entityId,
      generatedAt: new Date().toISOString(),
      gatewayRef: tx?.gatewayRef ?? null,
      driver: tx?.driver ?? null,
      // Authoritative compliance status comes from the Transmission row (set by
      // the gateway), NOT the client-writable invoice record. With no
      // transmission, the invoice was never actually sent — say so plainly. A
      // simulated transmission is the same case wearing a gateway ref: the
      // document did not leave the machine, so these two fields say so and the
      // simulator's own values are quarantined under `simulation` below, where
      // nobody can mistake them for something a counterparty sent.
      exchangeStatus: !tx || simulated ? "NOT_TRANSMITTED" : tx.exchangeStatus,
      reportingStatus: !tx || simulated ? "NOT_REPORTED" : tx.reportingStatus,
      transmitted: Boolean(tx) && !simulated,
      simulation:
        tx && simulated
          ? {
              driver: tx.driver,
              simulatedExchangeStatus: tx.exchangeStatus,
              simulatedReportingStatus: tx.reportingStatus,
              note: "Produced in-process by the driver named above. Not an acknowledgement from any Access Point or from the FTA.",
            }
          : null,
      retention: { basisYears: RECORD_RETENTION.years, basis: RECORD_RETENTION.basis, note: RECORD_RETENTION.note },
      parts: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, { sha256: sha(v), bytes: Buffer.byteLength(v) }])),
    };

    return json({ manifest, parts });
  } catch (e) {
    return handleError(e);
  }
}
