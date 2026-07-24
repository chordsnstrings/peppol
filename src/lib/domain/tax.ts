import { halfUp } from "./money";
import type {
  CategoryBreakdown,
  DocType,
  InvoiceLine,
  InvoiceTotals,
  TaxProfile,
  TaxProfileCode,
} from "./types";

/**
 * System tax profiles (seeded). Category codes follow the UAE/PINT AE convention
 * placeholders — the exact code values are loaded from vendored artefacts in the
 * real build (§3.3). Rates are the regulatory ground truth.
 */
export const TAX_PROFILES: Record<TaxProfileCode, TaxProfile> = {
  STANDARD_5: {
    code: "STANDARD_5",
    label: "Standard rate 5%",
    categoryCode: "S",
    ratePercent: 5,
    requiresExemptionReason: false,
    isTaxable: true,
    hint: "The default for most taxable supplies in the UAE.",
  },
  ZERO_EXPORT: {
    code: "ZERO_EXPORT",
    label: "Zero-rated — export",
    categoryCode: "Z",
    ratePercent: 0,
    requiresExemptionReason: true,
    isTaxable: true,
    hint: "Exports of goods/services outside the GCC. Needs a reason.",
  },
  ZERO_OTHER: {
    code: "ZERO_OTHER",
    label: "Zero-rated — other",
    categoryCode: "Z",
    ratePercent: 0,
    requiresExemptionReason: true,
    isTaxable: true,
    hint: "Healthcare, education, first-supply residential, etc.",
  },
  EXEMPT: {
    code: "EXEMPT",
    label: "Exempt",
    categoryCode: "E",
    ratePercent: 0,
    requiresExemptionReason: true,
    isTaxable: false,
    hint: "Financial services, bare land, local transport.",
  },
  OUT_OF_SCOPE: {
    code: "OUT_OF_SCOPE",
    label: "Out of scope",
    categoryCode: "O",
    ratePercent: 0,
    requiresExemptionReason: false,
    isTaxable: false,
    hint: "Transactions outside UAE VAT. Issues a commercial invoice.",
  },
  REVERSE_CHARGE: {
    code: "REVERSE_CHARGE",
    label: "Reverse charge",
    categoryCode: "AE",
    ratePercent: 0,
    requiresExemptionReason: false,
    isTaxable: true,
    hint: "Buyer accounts for VAT (imported services). Buyer TRN required.",
  },
};

export const TAX_PROFILE_LIST = Object.values(TAX_PROFILES);

export function getProfile(code: TaxProfileCode): TaxProfile {
  return TAX_PROFILES[code] ?? TAX_PROFILES.STANDARD_5;
}

/** Compute a single line's net + informational VAT. */
export function computeLine(line: Pick<InvoiceLine, "qty" | "unitPriceMinor" | "taxProfileCode">): {
  lineNetMinor: number;
  lineVatMinor: number;
} {
  const profile = getProfile(line.taxProfileCode);
  const netRaw = line.qty * line.unitPriceMinor;
  const lineNetMinor = halfUp(netRaw);
  const lineVatMinor = halfUp((lineNetMinor * profile.ratePercent) / 100);
  return { lineNetMinor, lineVatMinor };
}

/**
 * Compute document totals from lines using EN 16931 style: VAT rounded per
 * category subtotal, not per line (§7.5).
 */
export function computeTotals(lines: InvoiceLine[]): InvoiceTotals {
  const byCategory = new Map<string, CategoryBreakdown>();
  let taxExclusiveMinor = 0;

  for (const line of lines) {
    const profile = getProfile(line.taxProfileCode);
    const { lineNetMinor } = computeLine(line);
    taxExclusiveMinor += lineNetMinor;

    const key = `${profile.categoryCode}:${profile.ratePercent}`;
    const existing = byCategory.get(key);
    if (existing) {
      existing.taxableMinor += lineNetMinor;
    } else {
      byCategory.set(key, {
        categoryCode: profile.categoryCode,
        profileCode: profile.code,
        ratePercent: profile.ratePercent,
        taxableMinor: lineNetMinor,
        vatMinor: 0,
      });
    }
  }

  let vatMinor = 0;
  const perCategory: CategoryBreakdown[] = [];
  for (const cat of byCategory.values()) {
    cat.vatMinor = halfUp((cat.taxableMinor * cat.ratePercent) / 100);
    vatMinor += cat.vatMinor;
    perCategory.push(cat);
  }

  const taxInclusiveMinor = taxExclusiveMinor + vatMinor;
  return {
    taxExclusiveMinor,
    vatMinor,
    taxInclusiveMinor,
    payableMinor: taxInclusiveMinor,
    perCategory: perCategory.sort((a, b) => b.ratePercent - a.ratePercent),
  };
}

/** Recompute lines' cached net/vat in place-immutably. */
export function recomputeLines(lines: InvoiceLine[]): InvoiceLine[] {
  return lines.map((l, i) => {
    const { lineNetMinor, lineVatMinor } = computeLine(l);
    return { ...l, lineNo: i + 1, lineNetMinor, lineVatMinor };
  });
}

/**
 * Doc-type is derived, never picked cold (§3.3). Any taxable line ⇒ TAX_INVOICE;
 * exempt/out-of-scope only ⇒ COMMERCIAL_INVOICE.
 */
export function deriveDocType(
  lines: InvoiceLine[],
  opts: { isCreditNote?: boolean } = {},
): DocType {
  if (opts.isCreditNote) return "TAX_CREDIT_NOTE";
  const anyTaxable = lines.some((l) => getProfile(l.taxProfileCode).isTaxable);
  return anyTaxable ? "TAX_INVOICE" : "COMMERCIAL_INVOICE";
}

export const DOC_TYPE_LABEL: Record<DocType, string> = {
  TAX_INVOICE: "Tax invoice",
  TAX_CREDIT_NOTE: "Credit note",
  COMMERCIAL_INVOICE: "Commercial invoice",
};

/** Common UN/ECE Rec 20 unit codes surfaced in the editor. */
export const UNIT_CODES: { code: string; label: string }[] = [
  { code: "C62", label: "Each (unit)" },
  { code: "HUR", label: "Hour" },
  { code: "DAY", label: "Day" },
  { code: "MON", label: "Month" },
  { code: "KGM", label: "Kilogram" },
  { code: "MTR", label: "Metre" },
  { code: "LTR", label: "Litre" },
  { code: "MTK", label: "Square metre" },
  { code: "SET", label: "Set" },
  { code: "PR", label: "Pair" },
];
