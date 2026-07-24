import { createHash } from "node:crypto";
import { requireSession } from "@/lib/server/session";
import { json, handleError } from "@/lib/server/http";
import { getRecord, listRecords } from "@/lib/server/store";
import { prisma } from "@/lib/server/prisma";
import type { Invoice, InvoiceEvent } from "@/lib/domain/types";

export const runtime = "nodejs";

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/**
 * Compliance evidence bundle for one invoice (spec §7.7): CIM snapshot + final
 * UBL + Tax Data Document + full event trail + a manifest with a SHA-256 of each
 * part. Downloadable so the SME can hand it to an FTA auditor.
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

    const cim = JSON.stringify(invoice, null, 2);
    const parts: Record<string, string> = { "cim.json": cim };
    if (tx) {
      parts["invoice.ubl.xml"] = tx.ublXml;
      parts["tax-data-document.xml"] = tx.tddXml;
    }
    parts["timeline.json"] = JSON.stringify(events, null, 2);

    const manifest = {
      invoiceNumber: invoice.number,
      docType: invoice.docType,
      entityId: invoice.entityId,
      generatedAt: new Date().toISOString(),
      gatewayRef: tx?.gatewayRef ?? null,
      driver: tx?.driver ?? null,
      exchangeStatus: invoice.exchangeStatus,
      reportingStatus: invoice.reportingStatusC2,
      retention: { basisYears: 5, note: "Baseline statutory retention; 15 years for real-estate-related." },
      parts: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, { sha256: sha(v), bytes: Buffer.byteLength(v) }])),
    };

    return json({ manifest, parts });
  } catch (e) {
    return handleError(e);
  }
}
