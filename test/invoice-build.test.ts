import { describe, it, expect } from "vitest";
import { buildInvoiceFromApi } from "@/lib/server/invoice-build";
import type { Entity } from "@/lib/domain/types";

const entity: Entity = {
  id: "ent-1",
  orgId: "org-1",
  legalNameEn: "Seller LLC",
  trn: "100123456700003",
  vatRegistered: true,
  taxGroup: false,
  defaultCurrency: "AED",
  einvoicingStatus: "LIVE",
  emaratLinked: true,
  numberingPrefix: "INV",
  numberingSeq: 1,
  activationChecklist: { detailsComplete: true, sandboxTestSent: true, emaratConfirmed: true, agreementAccepted: true },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("buildInvoiceFromApi", () => {
  it("computes totals and marks the source as API", () => {
    const inv = buildInvoiceFromApi(entity, {
      entityId: "ent-1",
      number: "API-1",
      buyer: { nameEn: "Buyer FZE" },
      lines: [{ description: "Service", qty: 2, unitPriceMinor: 50000, taxProfileCode: "STANDARD_5" }],
    });
    expect(inv.source).toBe("API");
    expect(inv.number).toBe("API-1");
    expect(inv.totals.taxExclusiveMinor).toBe(100000);
    expect(inv.totals.vatMinor).toBe(5000);
    expect(inv.totals.taxInclusiveMinor).toBe(105000);
    expect(inv.docType).toBe("TAX_INVOICE");
    expect(inv.lifecycleStatus).toBe("DRAFT");
  });

  it("defaults currency to the entity's and falls back to a valid tax profile", () => {
    const inv = buildInvoiceFromApi(entity, {
      entityId: "ent-1",
      buyer: { nameEn: "Buyer" },
      lines: [{ description: "X", qty: 1, unitPriceMinor: 1000, taxProfileCode: "NONSENSE" }],
    });
    expect(inv.currency).toBe("AED");
    expect(inv.lines[0].taxProfileCode).toBe("STANDARD_5");
  });

  it("derives the due date 30 days after supply", () => {
    const inv = buildInvoiceFromApi(entity, {
      entityId: "ent-1",
      supplyDate: "2026-07-01",
      buyer: { nameEn: "Buyer" },
      lines: [{ description: "X", qty: 1, unitPriceMinor: 1000 }],
    });
    expect(inv.dueDate).toBe("2026-07-31");
  });
});
