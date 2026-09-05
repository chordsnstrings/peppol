/**
 * How long the transmission archive has to survive, and why it is seven years.
 *
 * Article 56 of UAE Federal Decree-Law No. 47 of 2022 (Corporate Tax) requires
 * a taxable person to keep the records and documents supporting the information
 * in a Tax Return for SEVEN years following the end of the Tax Period they
 * relate to. VAT records are five years under Federal Decree-Law No. 8 of 2017
 * (fifteen for records relating to real estate), but a sales invoice is both a
 * VAT record and a corporate-tax record at the same time, so the longer period
 * is the one that governs the same document. The product used to state five,
 * which is the shorter of two rules that both apply — a statement that reads as
 * guidance and is wrong in the direction that destroys evidence.
 *
 * This lives beside the gateway because the archive it governs is the gateway's
 * own output: the Transmission row is the only place the exchanged PINT AE UBL
 * and the Tax Data Document exist. Delete it and the document a user would hand
 * an auditor is gone, whatever else the workspace still holds.
 */

export const RECORD_RETENTION = {
  years: 7,
  basis: "UAE Federal Decree-Law 47/2022 (Corporate Tax), Article 56",
  note:
    "Seven years after the end of the tax period the document belongs to. VAT records are five years under Federal Decree-Law 8/2017 and fifteen for real-estate-related records, but the same invoice is also a corporate-tax record, so the longer period applies.",
} as const;

/**
 * The earliest creation date still inside the window. Anything older than this
 * has served its statutory life; anything at or after it has not.
 *
 * The window is measured from the record's own date rather than from the end of
 * its tax period, which is the stricter reading — a document is kept for a few
 * months longer than the law demands rather than a few months less.
 */
export function retentionCutoff(now: Date = new Date()): Date {
  const cutoff = new Date(now);
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - RECORD_RETENTION.years);
  return cutoff;
}
