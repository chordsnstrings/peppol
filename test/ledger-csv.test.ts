import { describe, it, expect } from "vitest";
import { csvField, csvRow, csvFile, parseCsv } from "@/lib/server/ledger/csv";

/**
 * The comma-separated reader and writer, held to the round trip they exist for.
 *
 * `parseCsv` is not a convenience. It is what reads the FTA audit file back
 * after it has been written so the footers can be checked against the rows the
 * file actually contains, and what reads an export bundle back so its digest is
 * recomputed from what arrived rather than from the variables that produced it.
 * Both of those checks are only worth anything while the reader agrees with the
 * writer, and neither would report a disagreement in a way anybody could read:
 * a quoting rule that split one field into two would show up as a footer that
 * does not add up, or as a digest mismatch on a file nobody had touched.
 *
 * So the awkward values are pinned here, one by one, on the way out and back.
 * The writer is not exercised separately from the reader anywhere else in this
 * suite, and the failure it is guarding against is silent by construction.
 */

/** Out and back, which is the only property either half is really promising. */
const trip = (rows: string[][]) => parseCsv(rows.map(csvRow).join("\n"));

describe("writing a field", () => {
  it("leaves a plain value alone, because quoting everything makes a file nobody can read", () => {
    expect(csvField("6400")).toBe("6400");
    expect(csvField("Airport taxi")).toBe("Airport taxi");
    expect(csvField("")).toBe("");
  });

  it("quotes the four characters that would otherwise change the shape of the file", () => {
    expect(csvField("Taxi, airport")).toBe('"Taxi, airport"');
    expect(csvField('He said "hello"')).toBe('"He said ""hello"""');
    expect(csvField("line one\nline two")).toBe('"line one\nline two"');
    expect(csvField("line one\r\nline two")).toBe('"line one\r\nline two"');
  });

  it("doubles every quote in the value rather than only the first", () => {
    expect(csvField('""')).toBe('""""""');
  });

  it("joins a row with commas and a file with newlines", () => {
    expect(csvRow(["a", "b, c", "d"])).toBe('a,"b, c",d');
    expect(csvFile(["code", "name"], [["1010", "Bank"], ["2200", "Owed, staff"]]))
      .toBe('code,name\n1010,Bank\n2200,"Owed, staff"');
  });
});

describe("reading a file back", () => {
  it("reads the ordinary case", () => {
    expect(parseCsv("code,name\n1010,Bank")).toEqual([["code", "name"], ["1010", "Bank"]]);
  });

  it("keeps a comma inside a quoted field in the field it belongs to", () => {
    // The bug the whole module exists to prevent: a description with a comma in
    // it becoming two columns, which moves every column after it by one and is
    // invisible until somebody reads the wrong number out of the file.
    expect(parseCsv('EXP-1,"Taxi, airport",100.00')).toEqual([["EXP-1", "Taxi, airport", "100.00"]]);
  });

  it("gives back one quote where the file carries two", () => {
    expect(parseCsv('1,"He said ""hello""",3')).toEqual([["1", 'He said "hello"', "3"]]);
  });

  it("keeps a newline inside a quoted field instead of starting a row on it", () => {
    expect(parseCsv('1,"line one\nline two",3')).toEqual([["1", "line one\nline two", "3"]]);
    // And the carriage return of a CRLF written inside a value is part of the
    // value. Outside quotes it is a line ending and is dropped; inside them it
    // is content, which is what makes a pasted Windows address survive.
    expect(parseCsv('1,"line one\r\nline two",3')).toEqual([["1", "line one\r\nline two", "3"]]);
  });

  it("reads a file written with CRLF, which is what both writers here produce", () => {
    // `faf.ts` and `exports.ts` both join with \r\n and end with one, because a
    // spreadsheet on Windows is where these files get opened.
    expect(parseCsv("code,name\r\n1010,Bank\r\n")).toEqual([["code", "name"], ["1010", "Bank"]]);
  });

  it("reads the same rows whether or not the file ends with a newline", () => {
    const withNewline = parseCsv("a,b\nc,d\n");
    const without = parseCsv("a,b\nc,d");
    expect(withNewline).toEqual([["a", "b"], ["c", "d"]]);
    expect(without).toEqual(withNewline);
    // A trailing newline is the end of the last row and not the start of an
    // empty one. A phantom row would be counted by the FTA file's own footer
    // check and reported as a file that does not add up.
    expect(withNewline).toHaveLength(2);
  });

  it("tells an empty field from a missing one", () => {
    // Three columns with nothing in the middle one is not the same file as two
    // columns, and a reader that could not tell them apart would quietly shift
    // every column after the gap.
    expect(parseCsv("a,,c")).toEqual([["a", "", "c"]]);
    expect(parseCsv("a,c")).toEqual([["a", "c"]]);
    // Including at the end, where a trailing comma is a real empty field — the
    // FAF company row ends with three of them.
    expect(parseCsv("a,b,")).toEqual([["a", "b", ""]]);
    expect(parseCsv('a,"",c')).toEqual([["a", "", "c"]]);
  });

  it("returns nothing at all for an empty file", () => {
    expect(parseCsv("")).toEqual([]);
    expect(parseCsv("\n")).toEqual([[""]]);
  });

  it("treats a blank line as a row with one empty field, not as nothing", () => {
    // Stated rather than assumed: neither writer here emits a blank line, so
    // one in an uploaded bundle means the file was edited or is truncated, and
    // a reader that silently dropped it would hide that from the digest.
    expect(parseCsv("a\n\nb")).toEqual([["a"], [""], ["b"]]);
  });
});

describe("out and back", () => {
  it("returns every awkward value unchanged", () => {
    const rows = [
      ["reference", "description", "amount"],
      ["EXP-1", "Taxi, airport", "100.00"],
      ["EXP-2", 'Invoice marked "paid"', "-250.50"],
      ["EXP-3", "Suite 12\nAl Wasl Road", "0.00"],
      ["EXP-4", "Windows address\r\nDubai", "1.00"],
      ["EXP-5", "", "999999999999.99"],
      ["EXP-6", "  padded  ", "12.00"],
      ["EXP-7", 'a,b,"c"\nd', "3.00"],
    ];
    expect(trip(rows)).toEqual(rows);
  });

  it("keeps the column count the same for every row, which is what the footers are checked against", () => {
    // The FTA file recomputes its footers from the parsed rows, so a value that
    // gained or lost a column on the way out would produce a file that reports
    // itself as not adding up — with nothing to say which line did it.
    const rows = [
      ["C", "Company, LLC", "100123456700003", "AED"],
      ["P", "Taxi, airport", "1000.00", "50.00"],
      ["F", "1000.00", "50.00", "1"],
    ];
    const parsed = trip(rows);
    expect(parsed.map((r) => r.length)).toEqual([4, 4, 4]);
    expect(parsed.filter((r) => r[0] === "F")).toHaveLength(1);
  });

  it("survives the exact shape both writers produce — CRLF joined, CRLF terminated", () => {
    const rows = [["code", "name"], ["2200", "Owed to staff, unpaid"], ["6400", "Travel"]];
    const file = rows.map(csvRow).join("\r\n") + "\r\n";
    expect(parseCsv(file)).toEqual(rows);
  });

  it("survives the shape csvFile produces, header and all", () => {
    const header = ["code", "name"];
    const rows = [["1010", 'Bank — "main"'], ["2200", "Owed to staff, unpaid"]];
    expect(parseCsv(csvFile(header, rows))).toEqual([header, ...rows]);
  });

  it("does not care how many times a value goes round", () => {
    // A bundle can be exported, verified, and exported again from what was
    // read. A rule that quoted one round differently from the next would drift
    // a quote or a comma into the data a round at a time.
    const rows = [["a", 'He said "hello", twice'], ["b", "line\nbreak"]];
    expect(trip(trip(rows))).toEqual(rows);
  });
});
