import { halfUp } from "./money";
import type {
  AnyTaxProfile,
  AnyTaxProfileCode,
  CategoryBreakdown,
  DocType,
  InvoiceLine,
  InvoiceTotals,
  PurchaseTaxProfileCode,
  TaxProfile,
  TaxProfileCode,
  TaxableLine,
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
    hint: "Buyer accounts for VAT (e.g. certain domestic supplies). Buyer TRN required.",
  },
  DESIGNATED_ZONE: {
    code: "DESIGNATED_ZONE",
    label: "Designated zone",
    categoryCode: "O",
    ratePercent: 0,
    requiresExemptionReason: true,
    isTaxable: false,
    // Goods only, deliberately. Article 51 of Federal Decree-Law 8/2017 and
    // Article 51 of the Executive Regulation treat a designated zone as outside
    // the State for goods; the place of supply of SERVICES in a zone is inside
    // the State, so services there take the standard rate like any other
    // domestic supply. That is why there is no separate zone profile for them:
    // `designatedZoneTreatment()` in `src/lib/server/ledger/vat-schemes.ts`
    // already resolves a services supply in a zone to STANDARD_5, and a second
    // code for the same treatment would let a standard-rated supply sit under a
    // label the eye reads as a relief.
    hint:
      "Goods supplied within or between designated zones — out of scope, so on no box of the VAT 201. " +
      "Services in a zone are standard rated (Article 51): use the standard rate for those. Check the zone is on " +
      "the Cabinet Decision list and the goods are not consumed inside it.",
  },
  MARGIN_SCHEME: {
    code: "MARGIN_SCHEME",
    label: "Profit-margin scheme",
    categoryCode: "S",
    // The rate stays 5 because it is the rate the law applies; the scheme
    // changes what it is applied TO, not how big it is. `marginSchemeSupply`
    // in `src/lib/server/ledger/vat-schemes.ts` reads this same field, so
    // moving it here would move it there too.
    ratePercent: 5,
    requiresExemptionReason: true,
    isTaxable: true,
    hint:
      "Used goods (e.g. second-hand vehicles). Tax is 5/105 of the margin (Article 29), so the line needs the " +
      "purchase price. The invoice must say the scheme was applied and must show no tax amount (ER Article 43).",
  },
};

/**
 * Treatments a purchase can carry and a sales document cannot.
 *
 * Kept in a table of their own so `TAX_PROFILE_LIST` — which the invoice
 * editor, the product editor and the sales-order editor all render whole —
 * stays the set of treatments a supply can be raised under. An importer never
 * issues an invoice for its own import.
 */
export const PURCHASE_TAX_PROFILES: Record<PurchaseTaxProfileCode, AnyTaxProfile> = {
  IMPORT_GOODS: {
    code: "IMPORT_GOODS",
    label: "Goods imported into the UAE",
    // The same category the reverse charge carries, because it is the same
    // mechanism: the customer, not the supplier, accounts for the tax. The
    // note on TAX_PROFILES above applies here too — these code values are
    // placeholders until the vendored PINT AE artefacts are loaded.
    categoryCode: "AE",
    // The rate the law applies to an import (Article 48 of Federal Decree-Law
    // 8/2017 and the standard rate under Article 3). It is stated here rather
    // than left at nought so `importVatOnGoods` can read the rate from the
    // profile instead of restating five percent somewhere else — but the
    // document still shows no tax, exactly as a reverse-charge document does,
    // because the overseas supplier charged none.
    ratePercent: 5,
    requiresExemptionReason: false,
    isTaxable: true,
    hint:
      "Goods brought into the UAE. The importer accounts for the tax itself under Article 48 — box 6 of the " +
      "VAT 201 — and recovers the same amount in box 10, so it is cash-neutral where the input tax is " +
      "recoverable in full. The supplier's invoice carries no UAE VAT.",
  },
};

/** Every treatment, whichever side of the book raises it. */
export const ALL_TAX_PROFILES: Record<AnyTaxProfileCode, AnyTaxProfile> = {
  ...TAX_PROFILES,
  ...PURCHASE_TAX_PROFILES,
};

/**
 * Treatments that state no tax on the face of the document, though tax is due.
 *
 * A margin-scheme supply is forbidden from stating one (Executive Regulation
 * Article 43) and an import is never charged one by the overseas supplier, so
 * in both cases the per-line and per-category arithmetic below must produce
 * nothing. What is actually owed is reported separately — `marginTaxMinor` and
 * `importVatMinor` on the totals — so that it is visible without ever being
 * added to what the counterparty is asked to pay.
 */
const STATES_NO_TAX_ON_THE_DOCUMENT = new Set<AnyTaxProfileCode>(["MARGIN_SCHEME", "IMPORT_GOODS"]);

/** Credit-note reason codes (plain-language; UNTDID-aligned) `[VERIFY-LATEST]`. */
export const CREDIT_REASONS: { code: string; label: string }[] = [
  { code: "PRICE", label: "Price/quantity correction" },
  { code: "RETURN", label: "Goods returned" },
  { code: "CANCEL", label: "Order cancelled" },
  { code: "DISCOUNT", label: "Post-invoice discount / rebate" },
  { code: "DUPLICATE", label: "Duplicate invoice issued" },
  { code: "WRONG_CUSTOMER", label: "Issued to the wrong customer" },
  { code: "WRONG_TAX", label: "Incorrect tax treatment" },
  { code: "OTHER", label: "Other (explain in notes)" },
];

/** The treatments a document line may be coded to, in the order the pickers show them. */
export const TAX_PROFILE_LIST = Object.values(TAX_PROFILES);

/** The same list plus the purchase-only treatments, for a bill or expense editor. */
export const PURCHASE_TAX_PROFILE_LIST: AnyTaxProfile[] = [
  ...TAX_PROFILE_LIST,
  ...Object.values(PURCHASE_TAX_PROFILES),
];

/**
 * The profile behind a code.
 *
 * Two signatures rather than one widened signature. Handed a document code,
 * this still returns a profile whose `code` is a `TaxProfileCode` — which is
 * what lets `sales-orders.ts` keep subtotalling into a map keyed by that type.
 * Handed any code at all, including a purchase-only one, it returns the wider
 * shape. One function, and neither caller has to know about the other's half.
 */
export function getProfile(code: TaxProfileCode): TaxProfile;
export function getProfile(code: AnyTaxProfileCode): AnyTaxProfile;
export function getProfile(code: AnyTaxProfileCode): AnyTaxProfile {
  return ALL_TAX_PROFILES[code] ?? TAX_PROFILES.STANDARD_5;
}

/** Compute a single line's net + informational VAT. */
export function computeLine(line: Pick<TaxableLine, "qty" | "unitPriceMinor" | "taxProfileCode">): {
  lineNetMinor: number;
  lineVatMinor: number;
} {
  const profile = getProfile(line.taxProfileCode);
  const netRaw = line.qty * line.unitPriceMinor;
  const lineNetMinor = halfUp(netRaw);
  // A profit-margin-scheme line charges the buyer nothing in tax. Executive
  // Regulation Article 43 requires the invoice to state that the scheme has
  // been applied and NOT to state a tax amount — a tax figure on the face of it
  // is a figure the buyer can recover, and the supplier accounted for tax on
  // the margin alone, so the difference would leave the FTA permanently short.
  // The tax the supplier does owe is `marginSchemeLineTax`, and it is reported
  // on the totals rather than on the line the buyer reads.
  //
  // An import of goods states none for a different reason with the same
  // consequence: the overseas supplier is outside UAE VAT and charged nothing,
  // and the tax is the importer's own under Article 48. `importVatOnGoods`
  // reports it.
  const lineVatMinor = STATES_NO_TAX_ON_THE_DOCUMENT.has(profile.code)
    ? 0
    : halfUp((lineNetMinor * profile.ratePercent) / 100);
  return { lineNetMinor, lineVatMinor };
}

/**
 * The tax an importer must account for on goods it brought into the UAE.
 *
 * Article 48 of Federal Decree-Law 8/2017 makes the importer, not the overseas
 * supplier, liable for the tax on an import of goods. The importer declares it
 * as output tax in box 6 of the VAT 201 and recovers the same figure as input
 * tax in box 10, so where the input tax is recoverable in full no money moves —
 * but the transaction has to appear on both sides, and leaving it off the
 * output side is an understatement of output tax even though nothing was ever
 * paid across.
 *
 * Rounded once, on the total of the imported goods, for the reason EN 16931
 * gives for rounding per category rather than per line: two roundings of half a
 * fils each are a fils the return is out by.
 */
export function importVatOnGoods(
  lines: Pick<TaxableLine, "qty" | "unitPriceMinor" | "taxProfileCode">[],
): number {
  const profile = PURCHASE_TAX_PROFILES.IMPORT_GOODS;
  let net = 0;
  for (const l of lines) {
    if (l.taxProfileCode !== "IMPORT_GOODS") continue;
    net += computeLine(l).lineNetMinor;
  }
  return halfUp((net * profile.ratePercent) / 100);
}

export interface MarginLineTax {
  /** Selling price less purchase price. Never negative — see `taxMinor`. */
  marginMinor: number;
  /** The tax inside that margin. Nil where the margin is nil, negative, or unknown. */
  taxMinor: number;
  /** False where the line carries no usable purchase cost, so there is no margin to tax. */
  costKnown: boolean;
}

/**
 * The tax inside a profit-margin-scheme line.
 *
 * Article 29 of Federal Decree-Law 8/2017 lets a taxable person account for tax
 * on the profit margin instead of on the whole selling price. Article 43 of the
 * Executive Regulation defines that margin as the selling price less the
 * purchase price and treats the tax as INCLUDED in it, which is why this is
 * 5/105 of the margin and not 5% of it — 5% overstates the tax by a twentieth,
 * every time.
 *
 * This is the same rule as `marginSchemeSupply` in
 * `src/lib/server/ledger/vat-schemes.ts`, and the two are held to the same
 * figures on the same inputs by a test in `test/ledger-vat-schemes.test.ts`.
 * It is not imported from there: that module opens a Prisma client and this one
 * is bundled into the invoice editor in the browser, and it already imports
 * `getProfile` from here, so the import would be both a client-side Prisma
 * dependency and a genuine cycle.
 */
export function marginSchemeLineTax(
  line: Pick<TaxableLine, "qty" | "unitPriceMinor" | "taxProfileCode" | "marginPurchaseMinor">,
): MarginLineTax {
  const profile = getProfile(line.taxProfileCode);
  if (profile.code !== "MARGIN_SCHEME") return { marginMinor: 0, taxMinor: 0, costKnown: true };

  const cost = line.marginPurchaseMinor;
  // A missing cost is not a cost of nought. Reporting nil tax and saying the
  // cost is unknown lets the caller refuse the document; assuming nought would
  // tax the whole selling price, which is the very thing the scheme exists to
  // avoid. A negative purchase price is not a price at all.
  if (cost === undefined || cost === null || !(cost >= 0)) {
    return { marginMinor: 0, taxMinor: 0, costKnown: false };
  }

  const { lineNetMinor } = computeLine(line);
  const margin = BigInt(halfUp(lineNetMinor)) - BigInt(halfUp(cost));
  // Selling at or below cost produces no tax, and it does not produce a credit.
  // Netting a loss against another item's margin would recover tax on goods
  // that never bore any.
  if (margin <= 0n) return { marginMinor: 0, taxMinor: 0, costKnown: true };

  const rate = BigInt(profile.ratePercent);
  const tax = divHalfUp(margin * rate, 100n + rate);
  return { marginMinor: Number(margin), taxMinor: Number(tax), costKnown: true };
}

/**
 * Divide rounding halves away from zero, in BigInt so the multiplication
 * happens before the division and no money passes through a float. Rounding
 * once at the end is what keeps 5/105 of a margin within half a fils, and it
 * makes a refund and a sale of the same size round to the same figure.
 */
function divHalfUp(value: bigint, divisor: bigint): bigint {
  const neg = value < 0n;
  const abs = neg ? -value : value;
  const out = (abs * 2n + divisor) / (divisor * 2n);
  return neg ? -out : out;
}

/**
 * Compute document totals from lines using EN 16931 style: VAT rounded per
 * category subtotal, not per line (§7.5).
 */
export function computeTotals(lines: TaxableLine[]): InvoiceTotals {
  const byCategory = new Map<string, CategoryBreakdown>();
  let taxExclusiveMinor = 0;
  let marginTaxMinor = 0;
  let marginLinesWithoutCostCount = 0;
  let anyMarginLine = false;
  let anyImportLine = false;

  for (const line of lines) {
    const profile = getProfile(line.taxProfileCode);
    const { lineNetMinor } = computeLine(line);
    taxExclusiveMinor += lineNetMinor;

    if (profile.code === "IMPORT_GOODS") anyImportLine = true;
    const isMargin = profile.code === "MARGIN_SCHEME";
    if (isMargin) {
      anyMarginLine = true;
      const margin = marginSchemeLineTax(line);
      // Per line, not per category subtotal. The margin is a fact about one
      // supply (ER Article 43) — two used cars have two margins, and there is
      // no subtotal for the rate to be applied to. So this is the one place the
      // per-category rounding below does not govern.
      marginTaxMinor += margin.taxMinor;
      if (!margin.costKnown) marginLinesWithoutCostCount += 1;
    }

    // Margin-scheme lines get their own subtotal. Their profile carries
    // category S at 5%, exactly the key standard-rated lines use, so sharing it
    // would fold the selling price of used goods into the standard-rated
    // subtotal and charge 5% on the whole of it. An import of goods is the same
    // trap one category over: it carries AE at 5% and the reverse charge
    // carries AE at 0, so keying on the pair alone would put 5% of the customs
    // value on the face of a document that must show none.
    const key = STATES_NO_TAX_ON_THE_DOCUMENT.has(profile.code)
      ? `NO_TAX_STATED:${profile.code}`
      : `${profile.categoryCode}:${profile.ratePercent}`;
    const existing = byCategory.get(key);
    if (existing) {
      existing.taxableMinor += lineNetMinor;
    } else {
      byCategory.set(key, {
        categoryCode: profile.categoryCode,
        profileCode: profile.code,
        // The rate the DOCUMENT states. A margin-scheme supply states none: the
        // buyer is charged the price and no tax, so the breakdown on the face
        // of the invoice has to foot to nil or it contradicts itself. The 5% in
        // the profile is the rate applied to the margin behind it, and that
        // figure is reported in `marginTaxMinor`. An import states none for the
        // same arithmetic reason and a different legal one — the supplier is
        // outside UAE VAT — and its figure is `importVatMinor`.
        //
        // Which PINT AE category code a margin-scheme supply should carry is
        // not established anywhere in this codebase — the profile table above
        // says its category codes are placeholders — so the profile's own code
        // is left as it is rather than replaced with a guess.
        ratePercent: STATES_NO_TAX_ON_THE_DOCUMENT.has(profile.code) ? 0 : profile.ratePercent,
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
    // The margin tax is not added here. It is already inside the price the
    // buyer pays; charging it on top would collect it twice.
    payableMinor: taxInclusiveMinor,
    perCategory: perCategory.sort((a, b) => b.ratePercent - a.ratePercent),
    // Only on documents that have a margin-scheme line — on every other
    // document the fields would be noise that means nothing.
    ...(anyMarginLine ? { marginTaxMinor, marginLinesWithoutCostCount } : {}),
    // Likewise: a document with no imported goods on it has no self-accounted
    // import tax, and reporting a nought would read as a computed figure.
    ...(anyImportLine ? { importVatMinor: importVatOnGoods(lines) } : {}),
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
 *
 * A margin-scheme line is a taxable supply but it cannot be what makes a
 * document a tax invoice. Executive Regulation Article 43 forbids stating the
 * tax on it, and a tax invoice is precisely the document that states the tax —
 * so a used-car sale on its own is a commercial invoice bearing the words the
 * scheme requires. A document that also carries an ordinary taxable line is
 * still a tax invoice for that line, with the margin line showing no tax
 * beside it. An imported line is excluded for the same reason: no tax is stated
 * on it, because the importer owes the tax to the FTA rather than to the seller.
 */
export function deriveDocType(
  lines: TaxableLine[],
  opts: { isCreditNote?: boolean } = {},
): DocType {
  if (opts.isCreditNote) return "TAX_CREDIT_NOTE";
  const anyTaxable = lines.some((l) => {
    const profile = getProfile(l.taxProfileCode);
    return profile.isTaxable && !STATES_NO_TAX_ON_THE_DOCUMENT.has(profile.code);
  });
  return anyTaxable ? "TAX_INVOICE" : "COMMERCIAL_INVOICE";
}

export const DOC_TYPE_LABEL: Record<DocType, string> = {
  TAX_INVOICE: "Tax invoice",
  TAX_CREDIT_NOTE: "Credit note",
  COMMERCIAL_INVOICE: "Commercial invoice",
  PROFORMA: "Proforma invoice",
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
