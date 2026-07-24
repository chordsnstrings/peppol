/**
 * Peppol participant identity + UAE TRN/TIN handling (§3.4 REG-03, §8.1).
 * Deterministic — nothing here originates from an LLM.
 */

/** Strip common paste pollution from a TRN/TIN (spaces, dashes, labels, O→0). */
export function cleanTaxId(raw: string): string {
  return raw
    .replace(/[Oo]/g, "0")
    .replace(/[^\d]/g, "");
}

export interface TrnCheck {
  ok: boolean;
  cleaned: string;
  message?: string;
  tone: "success" | "warning" | "error" | "neutral";
}

/** UAE TRN is a 15-digit number. Pattern-only (no public checksum). */
export function validateTRN(raw: string): TrnCheck {
  if (!raw.trim()) return { ok: false, cleaned: "", tone: "neutral" };
  const cleaned = cleanTaxId(raw);
  if (cleaned.length === 15) {
    return { ok: true, cleaned, tone: "success", message: "Valid 15-digit TRN format." };
  }
  if (cleaned.length === 14) {
    return {
      ok: false,
      cleaned,
      tone: "warning",
      message: "14 digits — a leading zero may have been stripped by Excel.",
    };
  }
  if (/e\+/i.test(raw)) {
    return {
      ok: false,
      cleaned,
      tone: "error",
      message: "Looks like scientific notation. Re-export the column as text.",
    };
  }
  return {
    ok: false,
    cleaned,
    tone: "warning",
    message: `${cleaned.length} digits — a UAE TRN has 15.`,
  };
}

/** TIN path for non-VAT-registered entities (FTA-issued, 10-digit here). */
export function validateTIN(raw: string): TrnCheck {
  if (!raw.trim()) return { ok: false, cleaned: "", tone: "neutral" };
  const cleaned = cleanTaxId(raw);
  if (cleaned.length >= 10) {
    return { ok: true, cleaned, tone: "success", message: "TIN format accepted." };
  }
  return { ok: false, cleaned, tone: "warning", message: "A TIN is at least 10 digits." };
}

/**
 * Peppol ID derivation: scheme 0235 + first 10 digits of TRN/TIN → 0235:XXXXXXXXXX.
 * (§2, REG-03 — tax-group members use their own TIN.)
 */
export function derivePeppolId(taxId?: string): string | undefined {
  if (!taxId) return undefined;
  const digits = cleanTaxId(taxId);
  if (digits.length < 10) return undefined;
  return `0235:${digits.slice(0, 10)}`;
}

export function isWellFormedPeppolId(pid?: string): boolean {
  if (!pid) return false;
  return /^\d{4}:\d{6,}$/.test(pid.trim());
}

/** Emirates for the address dropdown. */
export const EMIRATES: { code: string; name: string }[] = [
  { code: "AZ", name: "Abu Dhabi" },
  { code: "DU", name: "Dubai" },
  { code: "SH", name: "Sharjah" },
  { code: "AJ", name: "Ajman" },
  { code: "UQ", name: "Umm Al Quwain" },
  { code: "RK", name: "Ras Al Khaimah" },
  { code: "FU", name: "Fujairah" },
];

export const CURRENCIES = ["AED", "USD", "EUR", "GBP", "SAR"];
