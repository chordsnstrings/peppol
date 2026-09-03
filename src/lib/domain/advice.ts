import { getProfile } from "./tax";
import type { Invoice } from "./types";

export interface Advisory {
  id: string;
  tone: "info" | "warning";
  title: string;
  body: string;
}

/**
 * Non-blocking, plain-language tax guidance surfaced in the editor. These catch
 * the treatments SMEs most often get wrong (exports, B2C, margin scheme,
 * reverse-charge, designated zone). Advisory only — the user decides.
 */
export function taxAdvisories(inv: Partial<Invoice>): Advisory[] {
  const out: Advisory[] = [];
  const lines = inv.lines ?? [];
  const buyer = inv.buyer;
  const foreignCurrency = Boolean(inv.currency && inv.currency !== "AED");
  const hasStandard = lines.some((l) => l.taxProfileCode === "STANDARD_5");
  const foreignCountry = Boolean(buyer?.address?.country && buyer.address.country !== "AE");

  // Likely export
  if ((foreignCurrency || foreignCountry) && hasStandard) {
    out.push({
      id: "export",
      tone: "info",
      title: "Selling outside the UAE?",
      body: "Exports of goods/services are usually zero-rated, not standard 5%. Switch those lines to “Zero-rated — export” with a reason if this is an export.",
    });
  }

  // B2C / missing buyer TRN on a taxable invoice
  if (buyer?.nameEn && !buyer.trn && hasStandard) {
    out.push({
      id: "no-trn",
      tone: "info",
      title: "No buyer TRN",
      body: "If your customer is a VAT-registered business, add their TRN so this can be delivered on the network. If they're a consumer, B2C sales are currently outside the e-invoicing mandate.",
    });
  }

  // Reverse charge without buyer TRN
  if (lines.some((l) => l.taxProfileCode === "REVERSE_CHARGE") && !buyer?.trn) {
    out.push({
      id: "rcm",
      tone: "warning",
      title: "Reverse charge needs the buyer's TRN",
      body: "Under reverse charge the buyer self-accounts for VAT — the buyer must be a UAE VAT-registered business. Add their TRN.",
    });
  }

  // Margin scheme. The tax is now computed — 5/105 of the margin, under
  // Article 29 and Executive Regulation Article 43 — so what is left to warn
  // about is the one input nothing in the ledger can supply: what the item
  // cost. Without it the margin cannot be worked out at all.
  const marginLines = lines.filter((l) => l.taxProfileCode === "MARGIN_SCHEME");
  if (marginLines.length) {
    const missing = marginLines.filter(
      (l) => l.marginPurchaseMinor === undefined || l.marginPurchaseMinor === null || !(l.marginPurchaseMinor >= 0),
    );
    out.push(
      missing.length
        ? {
            id: "margin",
            tone: "warning",
            title: "Margin scheme — the purchase price is missing",
            body:
              "The tax is 5/105 of the margin, so the ledger needs what the item cost you. Without it no tax is " +
              "computed and none is posted. Add the purchase price to each margin-scheme line.",
          }
        : {
            id: "margin",
            tone: "info",
            title: "Margin scheme — the invoice shows no tax",
            body:
              "Executive Regulation Article 43 forbids a margin-scheme invoice showing a tax amount, so this one " +
              "does not. The 5/105 of your margin is still owed to the FTA and is posted out of the revenue, not " +
              "added to what the customer pays.",
          },
    );
  }

  // Designated zone
  if (lines.some((l) => l.taxProfileCode === "DESIGNATED_ZONE")) {
    out.push({
      id: "dz",
      tone: "info",
      title: "Designated-zone supply",
      body: "Supplies within/between designated zones are often out of scope, but movement to the mainland is taxable. Confirm the treatment for this transaction.",
    });
  }

  // Foreign currency without an AED rate
  if (foreignCurrency && !inv.fx) {
    out.push({
      id: "fx",
      tone: "warning",
      title: "Add the AED conversion rate",
      body: "Foreign-currency invoices must carry the AED tax amount at the Central Bank rate for the supply date.",
    });
  }

  return out;
}

/** Line count by profile — used for a quick “this became a commercial invoice” note. */
export function docTypeExplanation(inv: Partial<Invoice>): string | null {
  const lines = inv.lines ?? [];
  if (lines.length === 0) return null;
  const anyTaxable = lines.some((l) => getProfile(l.taxProfileCode).isTaxable);
  if (!anyTaxable) {
    return "All lines are exempt or out of scope, so this is a Commercial Invoice (no VAT tax invoice required).";
  }
  return null;
}
