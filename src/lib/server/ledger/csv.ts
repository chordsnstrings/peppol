/**
 * RFC 4180 comma-separated values, written and read.
 *
 * This exists because three modules had grown their own copy — the FTA audit
 * file, the ledger export, and the opening-balance paste — and a quoting rule
 * that differs between the writer and the reader is a bug nobody sees until a
 * description contains a comma. One implementation, used by all of them, is
 * also the only way the round-trip check in the export means anything: reading
 * a file back with a different parser proves the parser agrees with itself.
 *
 * Bank statements are deliberately not parsed with this. A statement arrives in
 * whatever dialect the bank chose — tabs, semicolons, four different date
 * orders — and sniffing that is a separate job with different failure modes;
 * `bank-formats.ts` owns it.
 */

/** A field, quoted only when it has to be. */
export function csvField(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export const csvRow = (cells: string[]): string => cells.map(csvField).join(",");

/** A whole file: a header row and the rows under it, joined with newlines. */
export function csvFile(header: string[], rows: string[][]): string {
  return [csvRow(header), ...rows.map(csvRow)].join("\n");
}

/**
 * Read a file back into rows.
 *
 * Written as a character walk rather than a regular expression because a
 * quoted field may contain commas, newlines and doubled quotes, and no regular
 * expression that handles all three stays readable. The point of reading a
 * generated file back is to check the footers against the rows the file
 * actually contains rather than against the variables meant to produce them —
 * a quoting bug that split one field into two would otherwise pass every
 * in-memory assertion.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === ",") { row.push(field); field = ""; continue; }
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
    if (c === "\r") continue;
    field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}
