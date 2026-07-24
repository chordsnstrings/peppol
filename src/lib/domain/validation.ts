import { isWellFormedPeppolId, validateTRN } from "./peppol";
import { getProfile } from "./tax";
import type { Invoice, InvoiceLine } from "./types";

export type Severity = "ERROR" | "WARNING" | "INFO";

export interface Issue {
  code: string;
  severity: Severity;
  field?: string;
  message: string;
  fix?: string;
}

export interface ValidationResult {
  issues: Issue[];
  canSend: boolean;
  errors: number;
  warnings: number;
}

/**
 * Friendly, layered validation (a real subset of §7.4 L0–L3). Deterministic;
 * every issue has a plain-language message and, where possible, a fix hint.
 */
export function validateInvoice(inv: Partial<Invoice>): ValidationResult {
  const issues: Issue[] = [];
  const lines = inv.lines ?? [];

  // L0 structural
  if (!inv.number?.trim()) {
    issues.push({
      code: "AE-0001",
      severity: "ERROR",
      field: "number",
      message: "This invoice has no number yet.",
      fix: "We can generate one from your sequence.",
    });
  }
  if (lines.length === 0) {
    issues.push({
      code: "AE-0002",
      severity: "ERROR",
      field: "lines",
      message: "Add at least one line item before sending.",
    });
  }

  // Line-level
  lines.forEach((line, i) => {
    if (!line.description?.trim()) {
      issues.push({
        code: "AE-0100",
        severity: "ERROR",
        field: `lines.${i}.description`,
        message: `Line ${i + 1} needs a description.`,
      });
    }
    if (line.qty <= 0) {
      issues.push({
        code: "AE-0101",
        severity: "ERROR",
        field: `lines.${i}.qty`,
        message: `Line ${i + 1} quantity must be greater than zero.`,
      });
    }
    if (line.unitPriceMinor < 0) {
      issues.push({
        code: "AE-0102",
        severity: "ERROR",
        field: `lines.${i}.unitPrice`,
        message: `Line ${i + 1} price can't be negative.`,
      });
    }
    const profile = getProfile(line.taxProfileCode);
    if (profile.requiresExemptionReason && !line.exemptionReason?.trim()) {
      issues.push({
        code: "AE-0300",
        severity: "WARNING",
        field: `lines.${i}.exemptionReason`,
        message: `Line ${i + 1} is ${profile.label.toLowerCase()} — a reason is expected.`,
        fix: "Pick a reason so the buyer and FTA know why VAT is 0%.",
      });
    }
  });

  // Buyer identity
  if (!inv.buyer?.nameEn?.trim()) {
    issues.push({
      code: "AE-0200",
      severity: "ERROR",
      field: "buyer",
      message: "Choose or create a customer for this invoice.",
    });
  } else {
    const needsTrn = lines.some((l) => l.taxProfileCode === "REVERSE_CHARGE");
    if (needsTrn && !inv.buyer?.trn) {
      issues.push({
        code: "AE-0201",
        severity: "ERROR",
        field: "buyer.trn",
        message: "Reverse-charge lines require the buyer's TRN.",
        fix: "Add the buyer's 15-digit TRN.",
      });
    }
    if (inv.buyer?.trn) {
      const check = validateTRN(inv.buyer.trn);
      if (!check.ok) {
        issues.push({
          code: "AE-0202",
          severity: "WARNING",
          field: "buyer.trn",
          message: `Buyer TRN: ${check.message ?? "check the format"}`,
        });
      }
    }
    if (inv.buyer?.peppolId && !isWellFormedPeppolId(inv.buyer.peppolId)) {
      issues.push({
        code: "AE-0203",
        severity: "WARNING",
        field: "buyer.peppolId",
        message: "Buyer Peppol ID looks malformed.",
      });
    }
  }

  // Dates (REG-01 clock)
  if (inv.supplyDate && inv.issueDate && inv.supplyDate > inv.issueDate) {
    issues.push({
      code: "AE-0400",
      severity: "WARNING",
      field: "supplyDate",
      message: "Supply date is after the issue date — double-check the tax point.",
    });
  }
  if (inv.compliance?.breached) {
    issues.push({
      code: "AE-0401",
      severity: "WARNING",
      field: "compliance",
      message: "This is past the 14-day issuance window. You can still send it.",
    });
  }

  // FX
  if (inv.currency && inv.currency !== "AED" && !inv.fx) {
    issues.push({
      code: "AE-0500",
      severity: "WARNING",
      field: "fx",
      message: `${inv.currency} invoice needs an AED conversion rate for the tax total.`,
      fix: "Add the CBUAE rate for the supply date.",
    });
  }

  const errors = issues.filter((i) => i.severity === "ERROR").length;
  const warnings = issues.filter((i) => i.severity === "WARNING").length;
  return { issues, canSend: errors === 0, errors, warnings };
}

/** Quick readiness check used by list badges. */
export function invoiceReadiness(inv: Partial<Invoice>): "READY" | "ISSUES" {
  return validateInvoice(inv).canSend ? "READY" : "ISSUES";
}

export function computeCompliance(supplyDate: string): {
  taxableEventDate: string;
  daysRemaining: number;
  breached: boolean;
} {
  const deadline = new Date(supplyDate + "T00:00:00");
  deadline.setDate(deadline.getDate() + 14);
  const days = Math.round((deadline.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
  return { taxableEventDate: supplyDate, daysRemaining: days, breached: days < 0 };
}

export function emptyLine(lineNo = 1): InvoiceLine {
  return {
    id: Math.random().toString(36).slice(2),
    lineNo,
    description: "",
    qty: 1,
    unitCode: "C62",
    unitPriceMinor: 0,
    taxProfileCode: "STANDARD_5",
    lineNetMinor: 0,
    lineVatMinor: 0,
  };
}
