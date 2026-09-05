import { describe, it, expect } from "vitest";
import { buildInvoiceFromApi, type ApiInvoiceInput } from "@/lib/server/invoice-build";
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

/**
 * The rate a foreign-currency invoice converts at.
 *
 * There was no field for it, so an invoice raised through the public API in any
 * currency but dirhams could never state the AED tax that Article 69 of Federal
 * Decree-Law 8/2017 and Article 59(1)(k) of the Executive Regulation both
 * require — and `validateInvoice` now refuses to send one that charges tax
 * without it, so the payload had no way to produce a sendable invoice at all.
 */
describe("buildInvoiceFromApi — the AED conversion", () => {
  const usd = (fx?: ApiInvoiceInput["fx"]) =>
    buildInvoiceFromApi(entity, {
      entityId: "ent-1",
      number: "API-FX",
      currency: "USD",
      supplyDate: "2026-07-01",
      buyer: { nameEn: "Buyer FZE" },
      fx,
      lines: [{ description: "Service", qty: 2, unitPriceMinor: 50_000 }],
    });

  it("carries the rate onto the invoice and records the tax in AED", () => {
    // 1,000.00 USD of goods, 50.00 USD of tax. At 3.6725 the tax is 18,362.5
    // fils, which rounds away from zero to 183.63 AED.
    const inv = usd({ rateToAED: "3.6725", source: "CBUAE", rateDate: "2026-07-01" });
    expect(inv.fx).toEqual({ rateToAED: "3.6725", source: "CBUAE", rateDate: "2026-07-01" });
    expect(inv.totals.vatMinorAED).toBe(18_363);
    expect(inv.totals.payableMinorAED).toBe(385_613);
    // The document currency is untouched: the conversion is stated beside the
    // figures, not in place of them.
    expect(inv.totals.vatMinor).toBe(5_000);
  });

  it("does not call a rate the CBUAE's on the caller's silence, and dates it to the supply", () => {
    // The API cannot check where a rate came from, and the printed invoice says
    // "the CBUAE rate" for a CBUAE one. Article 69 fixes the conversion at the
    // date of supply, so a rate sent without a date is a rate for that day.
    const inv = usd({ rateToAED: "3.70" } as ApiInvoiceInput["fx"]);
    expect(inv.fx).toEqual({ rateToAED: "3.70", source: "MANUAL", rateDate: "2026-07-01" });
  });

  it("drops a rate nothing can convert at rather than storing it", () => {
    // A half-typed rate on an invoice looks like a stated conversion and is
    // not one. Dropped, so AE-0500 asks for a real one.
    for (const bad of ["3.", "0", "abc", "", "-3.67"]) {
      const inv = usd({ rateToAED: bad } as ApiInvoiceInput["fx"]);
      expect(inv.fx).toBeUndefined();
      expect(inv.totals.vatMinorAED).toBeUndefined();
    }
  });

  it("records nothing to convert on an AED invoice, whatever rate was sent", () => {
    const inv = buildInvoiceFromApi(entity, {
      entityId: "ent-1",
      buyer: { nameEn: "Buyer FZE" },
      fx: { rateToAED: "3.6725", source: "CBUAE", rateDate: "2026-07-01" },
      lines: [{ description: "Service", qty: 1, unitPriceMinor: 50_000 }],
    });
    expect(inv.currency).toBe("AED");
    expect(inv.totals.vatMinorAED).toBeUndefined();
  });
});
