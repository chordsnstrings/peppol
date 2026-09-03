import { fingerprintOf, type ImportLine } from "./bank";
import { exponentOf, fmtMinor } from "@/lib/ledger/format";

/**
 * Reading the files banks actually hand out.
 *
 * The importer in ./bank.ts takes one shape — a date, a description, a
 * reference, a signed amount in minor units and optionally the running
 * balance. Nothing here imports anything; everything here produces that shape,
 * out of MT940, CAMT.053, OFX/QFX and whatever CSV the bank's portal emitted
 * that morning. Parsing and importing are kept apart for the same reason
 * matching and posting are: a person should be able to look at what was read
 * before any of it is written down.
 *
 * Three rules run through the whole file, and they are the reason it is this
 * long rather than four regexes:
 *
 *   1. No amount ever becomes a float. 0.1 + 0.2 is a joke in a blog post and
 *      a restatement in a ledger. Amounts are read digit by digit into BigInt
 *      minor units, and an amount whose shape cannot be settled is refused
 *      rather than approximated.
 *
 *   2. Nothing is guessed where guessing is invisible. A misread date order
 *      moves transactions between months, and nothing downstream will ever
 *      look wrong — the VAT return is simply incorrect. So an unsettleable
 *      date order is refused, not picked.
 *
 *   3. Every parse carries its own proof. The file states an opening balance
 *      and a closing balance; the lines between them must explain the
 *      difference exactly. A file that does not foot to its own declared
 *      closing balance was truncated somewhere between the bank and here, and
 *      importing three quarters of a statement is worse than importing none of
 *      it, because the reconciliation will then be wrong in a way that looks
 *      like a bookkeeping error.
 */

/** Formats this module can read. */
export type StatementFormat = "MT940" | "CAMT053" | "OFX" | "CSV";

/** Which field of a numeric date is which. */
export type DateOrder = "DMY" | "MDY" | "YMD";

/** What a refusal knows beyond its sentence, so the caller can offer a fix. */
export interface BankFormatDetail {
  /** The columns a CSV sniffer thought it saw, when it needs them confirmed. */
  mapping?: CsvMapping;
  /** The values that made something impossible to settle. */
  samples?: string[];
  /** What the file did not contain. */
  missing?: string[];
}

/**
 * A refusal the user is meant to read. It carries a 422 like LedgerError does,
 * because a file this module cannot vouch for is a rejected submission and not
 * a server fault.
 */
export class BankFormatError extends Error {
  status = 422;
  detail: BankFormatDetail;
  constructor(message: string, detail: BankFormatDetail = {}) {
    super(message);
    this.name = "BankFormatError";
    this.detail = detail;
  }
}

/**
 * One statement line, in the shape importStatement() takes.
 *
 * It extends ImportLine rather than restating it so the compiler enforces the
 * contract: if the importer's input ever changes, this stops building instead
 * of quietly producing rows it will reject at runtime.
 */
export interface ParsedLine extends ImportLine {
  /** Signed minor units, debit-positive — money into the account is positive. */
  amountMinor: string;
  balanceMinor?: string;
  /** The bank's value date, where the file distinguishes it from the booking date. */
  valueDate?: string;
  /** The bank's own transaction type: NTRF, DEBIT, PMNT/RCDT/ESCT and so on. */
  kind?: string;
  /** Set when the bank marked the entry as reversing an earlier one. */
  reversal?: boolean;
  /**
   * The identity this line will have once imported.
   *
   * It is deliberately the *same* hash the importer stores — see fingerprintOf
   * in ./bank.ts — rather than a second opinion computed here. A preview that
   * says "you have already imported this" using a different hash from the one
   * the unique index enforces is a preview that will be wrong on the day it
   * matters. It covers the date, the narrative, the reference (the FITID where
   * the file gives one, because that is the bank's own idea of the line's
   * identity), the amount and the running balance; the balance is what keeps
   * two genuine 50.00 payments to the same merchant on the same day apart.
   */
  fingerprint: string;
}

/**
 * Opening + the lines = closing, checked against the file's own declared
 * balances. `provable` is false when the file declares only one of the two —
 * OFX gives a closing balance and no opening — because a proof that cannot
 * fail is not a proof, and saying so is more use than printing a tick.
 */
export interface FootingProof {
  provable: boolean;
  openingMinor: string | null;
  closingMinor: string | null;
  /** The sum of the parsed lines. */
  sumMinor: string;
  /** opening + sum. */
  expectedClosingMinor: string | null;
  /** expected − declared. Zero, or the size of what went missing. */
  differenceMinor: string | null;
  foots: boolean;
  lineCount: number;
  note: string;
}

export interface ParsedStatement {
  format: StatementFormat;
  /** The account the file says it is for: IBAN, ACCTID, or whatever :25: held. */
  account: string | null;
  statementNumber: string | null;
  currency: string | null;
  /** The file's own reference for this statement, where it has one. */
  reference: string | null;
  /** The date order actually used, and how it was settled. */
  dateOrder: DateOrder | null;
  openingMinor: string | null;
  closingMinor: string | null;
  lines: ParsedLine[];
  proof: FootingProof;
  warnings: string[];
}

/** A figure in a sentence a person reads, not a count of fils. */
function figure(minor: bigint, currency: string | null): string {
  return `${fmtMinor(minor, currency ?? "AED", { zero: "zero" })}${currency ? ` ${currency}` : ""}`;
}

export interface FormatGuess {
  format: StatementFormat | null;
  /** 0–100. Not a probability, a statement of how much of the file was recognised. */
  confidence: number;
  /** The markers that led to the guess, so a wrong guess is arguable. */
  saw: string[];
}

export interface ParseOptions {
  text: string;
  /** Skip detection. Useful when the user overrules a wrong guess. */
  format?: StatementFormat;
  /** Settle an ambiguous numeric date order that the data could not settle. */
  dateOrder?: DateOrder;
  /** Confirmed column indexes for a CSV whose headers were ambiguous. */
  columns?: Partial<Record<CsvRole, number>>;
  /** Decides how many minor digits an amount has. The file wins where it says. */
  currency?: string;
}

/* Bounds. A statement is a statement, not an archive; anything past these is
   either a mistake or an attempt to make the parser the slow part of the app. */
const MAX_TEXT = 8 * 1024 * 1024;
const MAX_NODES = 200_000;
const MAX_DEPTH = 64;

/* ------------------------------------------------------------- amounts --- */

interface NumberShape {
  /** The character the format *guarantees* is the decimal point. */
  decimal?: "." | ",";
  /** Whether thousands separators may appear at all. */
  grouped?: boolean;
}

/**
 * A decimal string to minor units, without ever touching a float.
 *
 * The hard part is not the arithmetic, it is deciding which separator is the
 * decimal point. `1.234,56` and `1,234.56` are the same money written by two
 * banks; `1,500` is a thousand five hundred in Dubai and could be one and a
 * half in Frankfurt. The rules, in order:
 *
 *   - Where the format guarantees a separator (MT940's comma, ISO 20022's
 *     dot), that guarantee is used and the other character is rejected.
 *   - Both characters present: the rightmost is the decimal point. There is no
 *     locale in which the group separator comes last.
 *   - One character, appearing more than once: it groups. `1.234.567` is not a
 *     number with two decimal points.
 *   - One character, appearing once, with exactly three digits after it: it
 *     groups — unless the currency has three minor digits, where `1,500` in a
 *     Kuwaiti statement really is one and a half dinars. The currency decides,
 *     because nothing else can.
 *   - Anything else: it is the decimal point.
 *
 * Group separators must each be followed by exactly three digits. That refuses
 * the Indian lakh grouping some core banking systems emit rather than reading
 * `1,23,456` as a hundred and twenty-three thousand; a refusal is recoverable,
 * a silent misread is not.
 *
 * More fractional digits than the currency has is only accepted when the extra
 * digits are zeros. `100.000` in an AED statement is a hundred dirhams written
 * carelessly; `100.005` is a separator we have read wrong.
 */
export function parseMinor(raw: string, exponent = 2, shape: NumberShape = { grouped: true }): bigint | null {
  let s = raw.replace(/[\s\u00a0\u202f'\u2019]/g, "");
  if (s === "") return null;

  let negative = false;
  const wrapped = /^\((.*)\)$/.exec(s);
  if (wrapped) { negative = true; s = wrapped[1]; }
  if (s.startsWith("-")) { negative = !negative; s = s.slice(1); }
  else if (s.startsWith("+")) s = s.slice(1);
  // Some core banking exports put the minus behind the digits.
  if (s.endsWith("-")) { negative = !negative; s = s.slice(0, -1); }
  else if (s.endsWith("+")) s = s.slice(0, -1);

  if (!/^[0-9.,]+$/.test(s)) return null;

  const dots = (s.match(/\./g) ?? []).length;
  const commas = (s.match(/,/g) ?? []).length;

  let decimal: "." | "," | null = null;
  if (shape.decimal) {
    const other = shape.decimal === "." ? "," : ".";
    if (s.includes(other) && !shape.grouped) return null;
    decimal = s.includes(shape.decimal) ? shape.decimal : null;
  } else if (dots > 0 && commas > 0) {
    if (shape.grouped === false) return null;
    decimal = s.lastIndexOf(".") > s.lastIndexOf(",") ? "." : ",";
  } else if (dots > 0 || commas > 0) {
    const ch: "." | "," = dots > 0 ? "." : ",";
    const count = dots > 0 ? dots : commas;
    const tail = s.length - s.lastIndexOf(ch) - 1;
    if (count > 1) {
      if (shape.grouped === false) return null;
      decimal = null;
    } else if (tail === 3 && exponent !== 3 && shape.grouped !== false) {
      decimal = null;
    } else {
      decimal = ch;
    }
  }

  let whole = s;
  let frac = "";
  if (decimal) {
    const at = s.lastIndexOf(decimal);
    whole = s.slice(0, at);
    frac = s.slice(at + 1);
  }
  if (!/^[0-9]*$/.test(frac)) return null;

  const group = decimal === "." ? "," : decimal === "," ? "." : null;
  if (group && whole.includes(group)) {
    if (shape.grouped === false) return null;
    if (!new RegExp(`^[0-9]{1,3}(?:\\${group}[0-9]{3})*$`).test(whole)) return null;
    whole = whole.split(group).join("");
  }
  // Only one separator kind was present and it grouped, e.g. "1,234,567".
  for (const sep of [",", "."]) {
    if (whole.includes(sep)) {
      if (shape.grouped === false) return null;
      if (!new RegExp(`^[0-9]{1,3}(?:\\${sep}[0-9]{3})*$`).test(whole)) return null;
      whole = whole.split(sep).join("");
    }
  }
  if (whole === "" && frac === "") return null;
  if (!/^[0-9]*$/.test(whole)) return null;

  if (frac.length > exponent) {
    if (!/^0*$/.test(frac.slice(exponent))) return null;
    frac = frac.slice(0, exponent);
  }
  const minor = BigInt((whole === "" ? "0" : whole) + frac.padEnd(exponent, "0"));
  return negative ? -minor : minor;
}

/* --------------------------------------------------------------- dates --- */

const MONTH_LENGTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isRealDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const len = m === 2 && leap ? 29 : MONTH_LENGTH[m - 1];
  return d <= len;
}

function iso(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * A two-digit year on a bank statement is this century. The 1970 pivot costs
 * nothing and keeps a genuinely old file from landing 100 years out.
 */
function fullYear(yy: number): number {
  return yy >= 100 ? yy : yy < 70 ? 2000 + yy : 1900 + yy;
}

const NUMERIC_DATE = /^(\d{1,4})[/.\-](\d{1,2})[/.\-](\d{1,4})$/;

export interface DateOrderVerdict {
  order: DateOrder | null;
  /** Every order still standing after the evidence. More than one means refuse. */
  candidates: DateOrder[];
  /** What settled it, or what failed to. */
  why: string;
  /** The values that could not be settled, for the refusal to quote. */
  samples: string[];
}

/**
 * Work out whether 03/04/2026 is the third of April or the fourth of March.
 *
 * The file itself usually settles it: one day past the twelfth anywhere in the
 * statement rules out the other reading, and an impossible date (31/02) rules
 * one out too. Where a month of statement lines happens to contain no day
 * above the twelfth, nothing in the file can settle it, and this returns no
 * order — the caller must refuse and ask, because picking one is a coin toss
 * whose outcome nobody can see. Being wrong shifts every line into the wrong
 * month, and a statement in the wrong month reconciles to nothing, misstates
 * the period, and looks exactly like ordinary bookkeeping until an auditor
 * finds it.
 */
export function detectDateOrder(values: string[]): DateOrderVerdict {
  let candidates: DateOrder[] = ["DMY", "MDY", "YMD"];
  const seen: string[] = [];
  let settledBy = "";

  for (const raw of values) {
    const v = raw.trim();
    if (!v) continue;
    const m = NUMERIC_DATE.exec(v);
    if (!m) continue;
    const a = Number(m[1]), b = Number(m[2]), c = Number(m[3]);
    seen.push(v);

    const fits: DateOrder[] = [];
    if (m[1].length === 4 || a > 31) {
      if (isRealDate(a, b, c)) fits.push("YMD");
    } else {
      if (m[3].length >= 2 && isRealDate(fullYear(c), b, a)) fits.push("DMY");
      if (m[3].length >= 2 && isRealDate(fullYear(c), a, b)) fits.push("MDY");
      if (m[1].length === 4 && isRealDate(a, b, c)) fits.push("YMD");
    }
    if (fits.length === 0) {
      return {
        order: null, candidates: [], samples: [v],
        why: `"${v}" is not a real date in any field order.`,
      };
    }
    const before = candidates;
    candidates = candidates.filter((o) => fits.includes(o));
    if (candidates.length === 0) {
      return {
        order: null, candidates: [], samples: seen.slice(-6),
        why: `"${v}" contradicts the order the earlier dates implied (${before.join(" or ")}).`,
      };
    }
    if (candidates.length === 1 && !settledBy) settledBy = v;
  }

  if (seen.length === 0) return { order: null, candidates: [], why: "No numeric dates were found.", samples: [] };
  if (candidates.length === 1) {
    return {
      order: candidates[0], candidates, samples: seen.slice(0, 6),
      why: candidates[0] === "YMD"
        ? "The dates are written year first, which cannot be read any other way."
        : `"${settledBy}" has a field above 12, which only fits ${candidates[0]}.`,
    };
  }
  return {
    order: null, candidates, samples: seen.slice(0, 6),
    why: `Every date in the file fits ${candidates.join(" and ")} equally — no day above the twelfth appears anywhere to settle it.`,
  };
}

/** A single value to ISO, given a settled order. Null when it is not a date. */
export function toIsoDate(raw: string, order: DateOrder): string | null {
  const v = raw.trim();
  const isoish = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(v);
  if (isoish) {
    const y = Number(isoish[1]), m = Number(isoish[2]), d = Number(isoish[3]);
    return isRealDate(y, m, d) ? iso(y, m, d) : null;
  }
  const m = NUMERIC_DATE.exec(v);
  if (!m) return null;
  const a = Number(m[1]), b = Number(m[2]), c = Number(m[3]);
  let y: number, mo: number, d: number;
  if (order === "YMD" || m[1].length === 4) { y = a; mo = b; d = c; }
  else if (order === "DMY") { y = fullYear(c); mo = b; d = a; }
  else { y = fullYear(c); mo = a; d = b; }
  return isRealDate(y, mo, d) ? iso(y, mo, d) : null;
}

/** YYMMDD, as MT940 writes every date. Unambiguous, so no order is needed. */
function isoFromYYMMDD(s: string): string | null {
  if (!/^\d{6}$/.test(s)) return null;
  const y = fullYear(Number(s.slice(0, 2))), m = Number(s.slice(2, 4)), d = Number(s.slice(4, 6));
  return isRealDate(y, m, d) ? iso(y, m, d) : null;
}

/** YYYYMMDD, as OFX writes DTPOSTED before its optional time and zone. */
function isoFromYYYYMMDD(s: string): string | null {
  const digits = s.trim().slice(0, 8);
  if (!/^\d{8}$/.test(digits)) return null;
  const y = Number(digits.slice(0, 4)), m = Number(digits.slice(4, 6)), d = Number(digits.slice(6, 8));
  return isRealDate(y, m, d) ? iso(y, m, d) : null;
}

/* ----------------------------------------------------------- assembly --- */

function tidy(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function finish(input: {
  format: StatementFormat;
  account: string | null;
  statementNumber: string | null;
  currency: string | null;
  reference: string | null;
  dateOrder: DateOrder | null;
  opening: bigint | null;
  closing: bigint | null;
  rows: Omit<ParsedLine, "fingerprint">[];
  warnings: string[];
  unprovable?: string;
}): ParsedStatement {
  const warnings = [...input.warnings];
  const money = (v: bigint) => figure(v, input.currency);

  const lines: ParsedLine[] = input.rows.map((r) => ({
    ...r,
    fingerprint: fingerprintOf({
      postedOn: r.postedOn,
      description: r.description,
      reference: r.reference,
      amountMinor: BigInt(r.amountMinor),
      balanceMinor: r.balanceMinor === undefined ? null : BigInt(r.balanceMinor),
    }),
  }));

  // Two lines the bank described identically are one line as far as the
  // importer's unique index is concerned, and the second will be skipped. That
  // is the right behaviour for a re-import and the wrong outcome here, so it is
  // said out loud rather than discovered as a missing 50 dirhams.
  const byPrint = new Map<string, number>();
  for (const l of lines) byPrint.set(l.fingerprint, (byPrint.get(l.fingerprint) ?? 0) + 1);
  for (const l of lines) {
    const n = byPrint.get(l.fingerprint) ?? 0;
    if (n > 1) {
      byPrint.set(l.fingerprint, 0);
      warnings.push(
        `${n} lines are identical in every field the file supplied (${l.postedOn}, ${l.description}). ` +
          `Only the first can be imported — the others cannot be told apart from it.`,
      );
    }
  }

  const sum = lines.reduce((a, l) => a + BigInt(l.amountMinor), 0n);
  const provable = input.opening !== null && input.closing !== null;
  const expected = input.opening === null ? null : input.opening + sum;
  const difference = provable && expected !== null ? expected - (input.closing as bigint) : null;

  const proof: FootingProof = {
    provable,
    openingMinor: input.opening?.toString() ?? null,
    closingMinor: input.closing?.toString() ?? null,
    sumMinor: sum.toString(),
    expectedClosingMinor: expected?.toString() ?? null,
    differenceMinor: difference?.toString() ?? null,
    foots: provable && difference === 0n,
    lineCount: lines.length,
    note: provable
      ? difference === 0n
        ? `The ${lines.length} line${lines.length === 1 ? "" : "s"} account for the whole movement between the opening and closing balances the file declares.`
        : `The lines do not reach the file's own closing balance. The gap is ${money(difference ?? 0n)} — something the bank sent is not in this file.`
      : input.unprovable ?? "The file does not declare both an opening and a closing balance, so the lines cannot be proved complete.",
  };

  if (provable && difference !== 0n) {
    warnings.push(proof.note);
  }

  return {
    format: input.format,
    account: input.account,
    statementNumber: input.statementNumber,
    currency: input.currency,
    reference: input.reference,
    dateOrder: input.dateOrder,
    openingMinor: proof.openingMinor,
    closingMinor: proof.closingMinor,
    lines,
    proof,
    warnings,
  };
}

/* ---------------------------------------------------------------- MT940 --- */

/** :61: — value date, entry date, mark, funds code, amount, type, references. */
const MT940_LINE = /^(\d{6})(\d{4})?(RC|RD|C|D)([A-Z])?([0-9][0-9,]{0,14})([NSF][A-Z0-9]{3})(.*)$/;
/** :60F: / :62F: / :64: — mark, date, currency, amount. */
const MT940_BALANCE = /^(C|D)(\d{6})([A-Z]{3})([0-9][0-9,]{0,14})$/;

interface Mt940Field { tag: string; value: string }

/** Fold the file into tags. A line not starting with ":" continues the one above. */
function mt940Fields(text: string): Mt940Field[] {
  const out: Mt940Field[] = [];
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.replace(/\s+$/, "");
    // SWIFT block headers and the end-of-message hyphen are envelope, not data.
    if (line === "-" || line.startsWith("{")) continue;
    const m = /^:(\d{2}[A-Z]?):(.*)$/.exec(line);
    if (m) out.push({ tag: m[1], value: m[2] });
    else if (out.length && line.trim() !== "") out[out.length - 1].value += `\n${line}`;
  }
  return out;
}

function parseMt940(text: string, currencyHint?: string): ParsedStatement {
  const fields = mt940Fields(text);
  if (fields.length === 0) throw new BankFormatError("Nothing in this file looks like an MT940 tag (:20:, :61:, :86:).");

  const warnings: string[] = [];
  const rows: Omit<ParsedLine, "fingerprint">[] = [];
  let reference: string | null = null;
  let account: string | null = null;
  let statementNumber: string | null = null;
  let currency: string | null = null;
  let opening: bigint | null = null;
  let closing: bigint | null = null;
  let open: Omit<ParsedLine, "fingerprint"> | null = null;

  const balance = (tag: string, value: string): bigint => {
    const m = MT940_BALANCE.exec(value.split("\n")[0].trim());
    if (!m) throw new BankFormatError(`The balance in :${tag}: is not readable: "${tidy(value)}".`);
    currency ??= m[3];
    const exp = exponentOf(currency ?? currencyHint ?? "AED");
    const amount = parseMinor(m[4], exp, { decimal: ",", grouped: false });
    if (amount === null) throw new BankFormatError(`The amount in :${tag}: is not readable: "${m[4]}".`);
    // C is a credit balance — money the bank owes the account holder — which is
    // a positive balance in the account, the same direction money-in carries.
    return m[1] === "C" ? amount : -amount;
  };

  for (const f of fields) {
    switch (f.tag) {
      case "20": reference = tidy(f.value) || null; break;
      case "25": account = tidy(f.value.split("\n")[0]) || null; break;
      case "28":
      case "28C": statementNumber = tidy(f.value) || null; break;
      case "60F":
      case "60M": if (opening === null) opening = balance(f.tag, f.value); break;
      case "62F":
      case "62M": closing = balance(f.tag, f.value); break;
      case "61": {
        if (open) { rows.push(open); open = null; }
        const [head, ...rest] = f.value.split("\n");
        const m = MT940_LINE.exec(head.trim());
        if (!m) throw new BankFormatError(`This :61: line is not readable: "${tidy(head)}".`);

        const valueDate = isoFromYYMMDD(m[1]);
        if (!valueDate) throw new BankFormatError(`The value date "${m[1]}" in a :61: line is not a real date.`);
        // The entry date carries only MMDD; its year is the value date's,
        // rolled back when the pair straddles a year end (value 27 Dec booked
        // 02 Jan reads as 0102, which is next year, not ten months ago).
        let postedOn = valueDate;
        if (m[2]) {
          const vy = Number(valueDate.slice(0, 4));
          const mm = Number(m[2].slice(0, 2)), dd = Number(m[2].slice(2, 4));
          for (const y of [vy, vy + 1, vy - 1]) {
            if (isRealDate(y, mm, dd)) {
              const cand = iso(y, mm, dd);
              const gap = Math.abs(Date.parse(cand) - Date.parse(valueDate));
              if (gap <= 90 * 86_400_000) { postedOn = cand; break; }
            }
          }
        }

        const exp = exponentOf(currency ?? currencyHint ?? "AED");
        const magnitude = parseMinor(m[5], exp, { decimal: ",", grouped: false });
        if (magnitude === null) throw new BankFormatError(`The amount "${m[5]}" in a :61: line is not readable.`);
        if (magnitude < 0n) throw new BankFormatError(`The amount "${m[5]}" in a :61: line is signed; MT940 carries the direction in the D/C mark.`);

        // The mark carries the direction and the amount is a magnitude, exactly
        // as everywhere else in the product. RC and RD are reversals: the
        // reversal of a credit is money leaving, and of a debit money arriving,
        // so the sign flips against the letter that follows the R.
        const mark = m[3];
        const reversal = mark === "RC" || mark === "RD";
        const incoming = mark === "C" || mark === "RD";
        const amountMinor = incoming ? magnitude : -magnitude;

        const tail = m[7] ?? "";
        const cut = tail.indexOf("//");
        const ownerRef = tidy(cut < 0 ? tail : tail.slice(0, cut));
        const bankRef = cut < 0 ? "" : tidy(tail.slice(cut + 2));
        const ref = (ownerRef && ownerRef.toUpperCase() !== "NONREF" ? ownerRef : "") || bankRef;

        open = {
          postedOn,
          valueDate,
          description: tidy(rest.join(" ")) || m[6],
          reference: ref || undefined,
          amountMinor: amountMinor.toString(),
          kind: m[6],
          ...(reversal ? { reversal: true } : {}),
        };
        if (reversal) {
          warnings.push(
            `The line dated ${postedOn} is marked ${mark} — a reversal of an earlier ${mark === "RC" ? "credit" : "debit"}. ` +
              `It has been read as ${incoming ? "money in" : "money out"}; the footing proof below is what confirms that reading.`,
          );
        }
        break;
      }
      case "86": {
        // :86: belongs to the :61: above it. One arriving before any :61: is
        // statement-level narrative and describes nothing we are importing.
        const narrative = tidy(f.value.replace(/\?\d{2}/g, " "));
        if (open) open.description = tidy(`${open.description === open.kind ? "" : open.description} ${narrative}`) || open.description;
        break;
      }
      default: break;
    }
  }
  if (open) rows.push(open);

  const missing: string[] = [];
  if (!reference) missing.push(":20:");
  if (opening === null) missing.push(":60F:");
  if (closing === null) missing.push(":62F:");
  if (missing.length) {
    throw new BankFormatError(
      `This MT940 is missing ${missing.join(" and ")}, which every statement must carry. ` +
        `A file without ${missing.length === 1 ? "it" : "them"} has been cut short somewhere between the bank and here, and cannot be proved complete.`,
      { missing },
    );
  }

  const zero = rows.filter((r) => BigInt(r.amountMinor) === 0n).length;
  if (zero) warnings.push(`${zero} line${zero === 1 ? "" : "s"} carried a zero amount and ${zero === 1 ? "was" : "were"} left out — there is nothing to reconcile against.`);

  return finish({
    format: "MT940",
    account, statementNumber, currency, reference,
    dateOrder: "YMD",
    opening, closing,
    rows: rows.filter((r) => BigInt(r.amountMinor) !== 0n),
    warnings,
  });
}

/* ------------------------------------------------------------------ XML --- */

interface XNode { name: string; attrs: Record<string, string>; text: string; children: XNode[] }

/**
 * A small, strict XML reader.
 *
 * It is written by hand rather than pulled in, and it is a scanner rather than
 * a set of regexes, because the failure mode of the obvious approach is the
 * one that matters: `/<Amt[^>]*>([^<]*)</` run over a file whose <Ntry> was
 * truncated mid-element will happily pair an amount with the wrong entry and
 * report a statement that looks entirely plausible. A scanner that maintains a
 * stack cannot do that — it stops at the first tag that does not close, and
 * says which one.
 *
 * It evaluates nothing. Document type declarations are refused outright rather
 * than ignored, because the only reason a bank statement carries a <!DOCTYPE>
 * is that something else put it there; entity references outside the five XML
 * defines are refused for the same reason.
 */
function readXml(src: string): XNode {
  if (src.length > MAX_TEXT) throw new BankFormatError("This file is too large to read as a statement.");
  const root: XNode = { name: "#root", attrs: {}, text: "", children: [] };
  const stack: XNode[] = [root];
  let nodes = 0;
  let i = 0;

  const top = () => stack[stack.length - 1];

  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt < 0) { top().text += decodeXml(src.slice(i)); break; }
    if (lt > i) top().text += decodeXml(src.slice(i, lt));

    if (src.startsWith("<!--", lt)) {
      const end = src.indexOf("-->", lt + 4);
      if (end < 0) throw new BankFormatError("The XML ends inside a comment — the file was truncated.", { missing: ["-->"] });
      i = end + 3; continue;
    }
    if (src.startsWith("<![CDATA[", lt)) {
      const end = src.indexOf("]]>", lt + 9);
      if (end < 0) throw new BankFormatError("The XML ends inside a CDATA section — the file was truncated.", { missing: ["]]>"] });
      top().text += src.slice(lt + 9, end);
      i = end + 3; continue;
    }
    if (src.startsWith("<!", lt)) {
      throw new BankFormatError(
        "This XML carries a document type or entity declaration. A bank statement has no use for one, so it is refused rather than processed.",
      );
    }
    if (src.startsWith("<?", lt)) {
      const end = src.indexOf("?>", lt + 2);
      if (end < 0) throw new BankFormatError("The XML ends inside a processing instruction — the file was truncated.", { missing: ["?>"] });
      i = end + 2; continue;
    }

    const gt = findTagEnd(src, lt);
    if (gt < 0) {
      throw new BankFormatError(
        `The XML ends in the middle of a tag ("${src.slice(lt, Math.min(src.length, lt + 40))}") — the file was truncated in transit.`,
        { missing: [">"] },
      );
    }
    let inner = src.slice(lt + 1, gt);

    if (inner.startsWith("/")) {
      const name = localName(inner.slice(1).trim());
      if (stack.length === 1) throw new BankFormatError(`The XML closes </${name}> with nothing open.`);
      if (top().name !== name) {
        throw new BankFormatError(`The XML closes </${name}> while <${top().name}> is still open — the file is damaged or truncated.`);
      }
      stack.pop();
      i = gt + 1; continue;
    }

    const selfClosing = inner.endsWith("/");
    if (selfClosing) inner = inner.slice(0, -1);
    const m = /^([^\s/>]+)([\s\S]*)$/.exec(inner);
    if (!m) throw new BankFormatError(`The XML has an unreadable tag: "<${inner}>".`);
    if (++nodes > MAX_NODES) throw new BankFormatError("This XML has more elements than a statement plausibly holds.");

    const node: XNode = { name: localName(m[1]), attrs: readAttrs(m[2]), text: "", children: [] };
    top().children.push(node);
    if (!selfClosing) {
      stack.push(node);
      if (stack.length > MAX_DEPTH) throw new BankFormatError("This XML nests deeper than a statement plausibly does.");
    }
    i = gt + 1;
  }

  if (stack.length > 1) {
    const names = stack.slice(1).map((n) => `<${n.name}>`).join(" inside ");
    throw new BankFormatError(
      `The XML ends with ${names} still open — the file was truncated in transit, and the entries after that point are missing.`,
      { missing: stack.slice(1).map((n) => `</${n.name}>`) },
    );
  }
  const doc = root.children[0];
  if (!doc) throw new BankFormatError("There is no XML element in this file.");
  return doc;
}

/** The end of a tag, ignoring any ">" that sits inside a quoted attribute. */
function findTagEnd(src: string, from: number): number {
  let quote: string | null = null;
  for (let i = from + 1; i < src.length; i++) {
    const c = src[i];
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === ">") return i;
  }
  return -1;
}

function localName(qname: string): string {
  const at = qname.lastIndexOf(":");
  return at < 0 ? qname : qname.slice(at + 1);
}

function readAttrs(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([^\s=/]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let consumed = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    out[localName(m[1])] = decodeXml(m[3] ?? m[4] ?? "");
    consumed = re.lastIndex;
  }
  if (src.slice(consumed).trim() !== "") throw new BankFormatError(`Unreadable attributes in an XML tag: "${tidy(src)}".`);
  return out;
}

const XML_ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

/** The five entities XML defines, plus numeric references. Nothing else. */
function decodeXml(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);?/g, (whole, body: string) => {
    if (!whole.endsWith(";")) throw new BankFormatError(`The XML contains a bare "&" that is not an entity reference.`);
    if (body.startsWith("#")) {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 1 || code > 0x10ffff) throw new BankFormatError(`The XML contains an out-of-range character reference "&${body};".`);
      return String.fromCodePoint(code);
    }
    const known = XML_ENTITIES[body];
    if (known === undefined) throw new BankFormatError(`The XML references an entity "&${body};" that XML does not define. It is refused rather than resolved.`);
    return known;
  });
}

const kids = (n: XNode | undefined, name: string): XNode[] => (n ? n.children.filter((c) => c.name === name) : []);
const kid = (n: XNode | undefined, name: string): XNode | undefined => n?.children.find((c) => c.name === name);
const at = (n: XNode | undefined, ...path: string[]): XNode | undefined => path.reduce<XNode | undefined>((acc, p) => kid(acc, p), n);
const txt = (n: XNode | undefined): string => (n ? tidy(n.text) : "");

/** First descendant with this name, breadth first. */
function descend(n: XNode, name: string): XNode | undefined {
  const queue = [n];
  while (queue.length) {
    const cur = queue.shift() as XNode;
    if (cur.name === name) return cur;
    queue.push(...cur.children);
  }
  return undefined;
}

/* ------------------------------------------------------------- CAMT.053 --- */

function camtAmount(node: XNode | undefined, currencyHint: string | null, what: string): { minor: bigint; currency: string | null } {
  if (!node) throw new BankFormatError(`A ${what} in this CAMT.053 has no <Amt>.`);
  const ccy = node.attrs.Ccy || null;
  const exp = exponentOf(ccy ?? currencyHint ?? "AED");
  // ISO 20022 amounts are plain decimals with a dot and no grouping. Accepting
  // anything looser here would be accepting a file that is not a CAMT.053.
  const minor = parseMinor(txt(node), exp, { decimal: ".", grouped: false });
  if (minor === null) throw new BankFormatError(`The ${what} amount "${txt(node)}" is not a plain ISO 20022 decimal.`);
  if (minor < 0n) throw new BankFormatError(`The ${what} amount "${txt(node)}" is signed; ISO 20022 carries the direction in <CdtDbtInd>.`);
  return { minor, currency: ccy };
}

function camtDate(entry: XNode, tag: "BookgDt" | "ValDt"): string | null {
  const holder = kid(entry, tag);
  if (!holder) return null;
  const plain = txt(kid(holder, "Dt"));
  if (plain) return toIsoDate(plain, "YMD");
  const stamp = txt(kid(holder, "DtTm"));
  if (stamp) return toIsoDate(stamp.slice(0, 10), "YMD");
  return null;
}

function parseCamt053(text: string, currencyHint?: string): ParsedStatement {
  const doc = readXml(text);
  const report = descend(doc, "BkToCstmrStmt");
  if (!report) {
    throw new BankFormatError(
      "This XML has no <BkToCstmrStmt>, so it is not a CAMT.053 bank-to-customer statement.",
      { missing: ["BkToCstmrStmt"] },
    );
  }
  const statements = kids(report, "Stmt");
  if (statements.length === 0) throw new BankFormatError("This CAMT.053 contains no <Stmt>.", { missing: ["Stmt"] });

  const warnings: string[] = [];
  if (statements.length > 1) {
    warnings.push(`The file holds ${statements.length} statements. Only the first (${txt(kid(statements[0], "Id")) || "unnamed"}) has been read — import them one at a time so each one's footing is proved on its own.`);
  }
  const stmt = statements[0];

  const acct = kid(stmt, "Acct");
  const account = txt(at(acct, "Id", "IBAN")) || txt(at(acct, "Id", "Othr", "Id")) || null;
  let currency: string | null = txt(kid(acct, "Ccy")) || null;

  let opening: bigint | null = null;
  let closing: bigint | null = null;
  let openingCode = "";
  let closingCode = "";
  for (const bal of kids(stmt, "Bal")) {
    const code = txt(at(bal, "Tp", "CdOrPrtry", "Cd")) || txt(at(bal, "Tp", "CdOrPrtry", "Prtry"));
    const { minor, currency: ccy } = camtAmount(kid(bal, "Amt"), currency, `<Bal> ${code || "with no code"}`);
    currency ??= ccy;
    const ind = txt(kid(bal, "CdtDbtInd")).toUpperCase();
    if (ind !== "CRDT" && ind !== "DBIT") throw new BankFormatError(`A <Bal> has <CdtDbtInd> "${ind}", which is neither CRDT nor DBIT.`);
    const signed = ind === "CRDT" ? minor : -minor;
    if ((code === "OPBD" || code === "PRCD") && opening === null) { opening = signed; openingCode = code; }
    if (code === "CLBD") { closing = signed; closingCode = code; }
  }
  if (opening === null) {
    for (const bal of kids(stmt, "Bal")) {
      if (txt(at(bal, "Tp", "CdOrPrtry", "Cd")) !== "OPAV") continue;
      const { minor } = camtAmount(kid(bal, "Amt"), currency, "<Bal> OPAV");
      opening = txt(kid(bal, "CdtDbtInd")).toUpperCase() === "CRDT" ? minor : -minor;
      openingCode = "OPAV";
      warnings.push("The file declares no OPBD opening balance, so the available balance (OPAV) has been used instead. It can differ from the booked balance by items on hold.");
      break;
    }
  }

  const missing: string[] = [];
  if (opening === null) missing.push("<Bal> OPBD");
  if (closing === null) missing.push("<Bal> CLBD");
  if (missing.length) {
    throw new BankFormatError(
      `This CAMT.053 declares no ${missing.join(" and no ")}. Without ${missing.length === 1 ? "it" : "both"} the lines cannot be proved to be the whole statement, and a partly imported statement is worse than none.`,
      { missing },
    );
  }
  if (openingCode === "PRCD") warnings.push("The opening balance is the previous closing balance (PRCD) rather than OPBD; they are the same figure when no entries fall between the two statements.");
  if (closingCode !== "CLBD") warnings.push("The closing balance is not a CLBD booked balance.");

  const rows: Omit<ParsedLine, "fingerprint">[] = [];
  const entries = kids(stmt, "Ntry");
  if (entries.length === 0) warnings.push("The statement declares balances but carries no <Ntry>. If the period had movement, this file is not all of it.");

  for (const entry of entries) {
    const status = txt(kid(entry, "Sts")) || txt(at(entry, "Sts", "Cd"));
    if (status && status.toUpperCase() !== "BOOK") {
      // A pending entry is not in the closing balance, so importing it would
      // break the very proof that makes this trustworthy.
      warnings.push(`An entry with status ${status} is not booked yet and has been left out — it is not in the closing balance either.`);
      continue;
    }
    const { minor, currency: ccy } = camtAmount(kid(entry, "Amt"), currency, "<Ntry>");
    if (ccy && currency && ccy !== currency) {
      warnings.push(`An entry is in ${ccy} while the statement is in ${currency}. Mixed currencies cannot foot; check this line before importing.`);
    }
    currency ??= ccy;

    const ind = txt(kid(entry, "CdtDbtInd")).toUpperCase();
    if (ind !== "CRDT" && ind !== "DBIT") {
      throw new BankFormatError(`An <Ntry> has <CdtDbtInd> "${ind || "(absent)"}", which is neither CRDT nor DBIT. The direction of an amount is not something to guess.`);
    }
    const rvsl = txt(kid(entry, "RvslInd")).toLowerCase();
    const reversal = rvsl === "true" || rvsl === "1";
    // A reversal's CdtDbtInd names the entry it undoes, so the money moves the
    // other way. MT940's RC/RD says the same thing with no room for argument,
    // and reading the two formats differently would be indefensible. Because
    // implementations do differ, every reversal is also named in the warnings
    // and the footing proof is what actually confirms the reading.
    const incoming = reversal ? ind === "DBIT" : ind === "CRDT";
    const amountMinor = incoming ? minor : -minor;

    const postedOn = camtDate(entry, "BookgDt") ?? camtDate(entry, "ValDt");
    if (!postedOn) throw new BankFormatError("An <Ntry> has neither a readable <BookgDt> nor a <ValDt>.");
    const valueDate = camtDate(entry, "ValDt") ?? undefined;

    const txDetails = kids(at(entry, "NtryDtls"), "TxDtls");
    const ustrd: string[] = [];
    for (const tx of txDetails) for (const u of kids(kid(tx, "RmtInf"), "Ustrd")) ustrd.push(txt(u));
    for (const u of kids(at(entry, "RmtInf"), "Ustrd")) ustrd.push(txt(u));
    const bkTxCd = [txt(at(entry, "BkTxCd", "Domn", "Cd")), txt(at(entry, "BkTxCd", "Domn", "Fmly", "Cd")), txt(at(entry, "BkTxCd", "Domn", "Fmly", "SubFmlyCd"))]
      .filter(Boolean).join("/");
    const description = tidy(ustrd.filter(Boolean).join(" ")) || txt(kid(entry, "AddtlNtryInf")) || bkTxCd || "(no narrative)";

    const reference =
      txt(kid(entry, "AcctSvcrRef")) ||
      txt(kid(entry, "NtryRef")) ||
      txt(at(txDetails[0], "Refs", "EndToEndId")) ||
      txt(at(txDetails[0], "Refs", "TxId")) ||
      undefined;

    rows.push({
      postedOn,
      valueDate,
      description,
      reference: reference && reference.toUpperCase() !== "NOTPROVIDED" ? reference : undefined,
      amountMinor: amountMinor.toString(),
      kind: bkTxCd || undefined,
      ...(reversal ? { reversal: true } : {}),
    });
    if (reversal) {
      warnings.push(
        `The entry dated ${postedOn} is flagged <RvslInd>true</RvslInd> — it reverses an earlier ${ind === "CRDT" ? "credit" : "debit"}. ` +
          `It has been read as ${incoming ? "money in" : "money out"}; the footing proof below is what confirms that reading.`,
      );
    }
  }

  const statementNumber = txt(kid(stmt, "LglSeqNb")) || txt(kid(stmt, "ElctrncSeqNb")) || null;
  const zero = rows.filter((r) => BigInt(r.amountMinor) === 0n).length;
  if (zero) warnings.push(`${zero} entr${zero === 1 ? "y" : "ies"} carried a zero amount and ${zero === 1 ? "was" : "were"} left out.`);

  return finish({
    format: "CAMT053",
    account, statementNumber, currency: currency ?? currencyHint ?? null,
    reference: txt(kid(stmt, "Id")) || null,
    dateOrder: "YMD",
    opening, closing,
    rows: rows.filter((r) => BigInt(r.amountMinor) !== 0n),
    warnings,
  });
}

/* ------------------------------------------------------------- OFX / QFX --- */

/**
 * OFX 1.x is SGML: tags open and very often never close, and the value runs
 * from the end of the tag to the next "<". OFX 2.x is XML. Reading "up to the
 * next tag" handles both without having to know which one arrived.
 */
function ofxValue(block: string, tag: string): string {
  const open = `<${tag}>`;
  const at = indexOfTag(block, open);
  if (at < 0) return "";
  const from = at + open.length;
  const to = block.indexOf("<", from);
  return tidy(block.slice(from, to < 0 ? block.length : to));
}

/**
 * Case-insensitive search for a literal tag.
 *
 * Upper-casing the whole file and searching that would be simpler and wrong:
 * a character whose uppercase form is longer than itself — "ß" becomes "SS" —
 * shifts every index after it, and a shifted index here slices an amount in
 * half.
 */
function indexOfTag(text: string, tag: string, from = 0): number {
  const re = new RegExp(tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  const at = text.slice(from).search(re);
  return at < 0 ? -1 : at + from;
}

function parseOfx(text: string, currencyHint?: string): ParsedStatement {
  const upper = text.toUpperCase();
  if (!upper.includes("<OFX") && !upper.includes("OFXHEADER")) {
    throw new BankFormatError("This file carries neither an OFX header nor an <OFX> element.", { missing: ["<OFX>"] });
  }

  const warnings: string[] = [];
  const rows: Omit<ParsedLine, "fingerprint">[] = [];

  const currency = ofxValue(text, "CURDEF") || currencyHint || null;
  const exp = exponentOf(currency ?? "AED");
  const account = ofxValue(text, "ACCTID") || null;

  let cursor = 0;
  let count = 0;
  for (;;) {
    const start = indexOfTag(text, "<STMTTRN>", cursor);
    if (start < 0) break;
    const end = indexOfTag(text, "</STMTTRN>", start);
    if (end < 0) {
      throw new BankFormatError(
        `Transaction ${count + 1} in this OFX file is missing its </STMTTRN> — the file was cut off part way through.`,
        { missing: ["</STMTTRN>"] },
      );
    }
    const block = text.slice(start + "<STMTTRN>".length, end);
    cursor = end + "</STMTTRN>".length;
    count += 1;

    const posted = isoFromYYYYMMDD(ofxValue(block, "DTPOSTED"));
    if (!posted) throw new BankFormatError(`Transaction ${count} has no readable <DTPOSTED> (found "${ofxValue(block, "DTPOSTED")}").`);
    const user = isoFromYYYYMMDD(ofxValue(block, "DTUSER")) ?? undefined;

    const rawAmount = ofxValue(block, "TRNAMT");
    // OFX signs the amount itself: money out is already negative, which is the
    // same convention the importer uses, so nothing is flipped here.
    const amountMinor = parseMinor(rawAmount, exp, { grouped: false });
    if (amountMinor === null) throw new BankFormatError(`Transaction ${count} has an unreadable <TRNAMT> ("${rawAmount}").`);

    const name = ofxValue(block, "NAME");
    const memo = ofxValue(block, "MEMO");
    const description = tidy([name, memo === name ? "" : memo].filter(Boolean).join(" — ")) || ofxValue(block, "TRNTYPE") || "(no narrative)";
    const kind = ofxValue(block, "TRNTYPE") || undefined;
    const fitid = ofxValue(block, "FITID") || undefined;

    if (amountMinor === 0n) {
      warnings.push(`Transaction ${count} (${description}) has a zero amount and has been left out — there is nothing to reconcile against.`);
      continue;
    }
    rows.push({
      postedOn: posted,
      valueDate: user,
      description,
      // FITID is the bank's own identifier for the line; using it as the
      // reference is what makes the fingerprint agree with the bank about
      // which transaction this is.
      reference: fitid,
      amountMinor: amountMinor.toString(),
      kind,
      ...(kind && /^(REVERSAL|XFER_REV|CREDIT_REV)$/i.test(kind) ? { reversal: true } : {}),
    });
  }

  if (count === 0) throw new BankFormatError("This OFX file contains no <STMTTRN> transactions.", { missing: ["<STMTTRN>"] });

  // LEDGERBAL is the booked closing balance; AVAILBAL is a different number
  // that also carries a <BALAMT>, so the search starts inside the right block.
  const ledgerAt = indexOfTag(text, "<LEDGERBAL>");
  const ledger = ledgerAt < 0 ? "" : ofxValue(text.slice(ledgerAt), "BALAMT");
  const closing = ledger ? parseMinor(ledger, exp, { grouped: false }) : null;
  if (ledger && closing === null) throw new BankFormatError(`The <LEDGERBAL> amount "${ledger}" is not readable.`);

  return finish({
    format: "OFX",
    account,
    statementNumber: null,
    currency,
    reference: ofxValue(text, "TRNUID") || null,
    dateOrder: "YMD",
    // OFX states where the account finished and never where it started, so the
    // arithmetic here would be a tautology. It is reported as unprovable rather
    // than dressed up as a proof that cannot fail.
    opening: null,
    closing,
    rows,
    warnings,
    unprovable: closing === null
      ? "This OFX file declares no balance at all, so nothing here can be checked against the bank's own figures."
      : `OFX declares only a closing balance (<LEDGERBAL>), never an opening one, so the lines cannot be proved to foot. Check the closing balance against the account before importing.`,
  });
}

/* ------------------------------------------------------------------ CSV --- */

export type CsvRole = "date" | "valueDate" | "description" | "amount" | "debit" | "credit" | "balance" | "reference";

export interface CsvMapping {
  delimiter: string;
  delimiterName: string;
  /** Which row the headers were on. Bank portals put a preamble above them. */
  headerRow: number;
  header: string[];
  columns: Partial<Record<CsvRole, number>>;
  /** Roles more than one header fits equally well, for a person to settle. */
  ambiguous: { role: CsvRole; candidates: { index: number; header: string }[] }[];
  /** Required roles no header fits. */
  missing: CsvRole[];
}

/**
 * The spellings UAE banks actually print, longest first within each role so a
 * more specific header wins its column. "Value Date" is a role of its own
 * rather than a second date, because a statement that books on one date and
 * values on another has to reconcile on the booking date.
 */
const ROLE_WORDS: Record<CsvRole, string[]> = {
  date: ["transaction date", "posting date", "posted date", "booking date", "date posted", "trans date", "tran date", "txn date", "date"],
  valueDate: ["value date", "value dt"],
  description: ["transaction details", "transaction description", "transaction remarks", "description", "narration", "narrative", "particulars", "details", "remarks", "payee"],
  amount: ["transaction amount", "amount"],
  debit: ["debit amount", "amount debited", "withdrawal", "withdrawals", "paid out", "money out", "debit", "dr"],
  credit: ["credit amount", "amount credited", "deposit", "deposits", "paid in", "money in", "credit", "cr"],
  balance: ["running balance", "closing balance", "ledger balance", "balance"],
  reference: ["transaction reference", "reference number", "cheque number", "instrument no", "cheque no", "reference", "ref no", "chq no", "ref"],
};

const DELIMITERS: { ch: string; name: string }[] = [
  { ch: ",", name: "comma" },
  { ch: ";", name: "semicolon" },
  { ch: "\t", name: "tab" },
  { ch: "|", name: "pipe" },
];

/** RFC 4180: quotes may hold the delimiter and newlines, and "" is one quote. */
function splitCsv(text: string, delim: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let started = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"' && field.trim() === "") { quoted = true; started = true; field = ""; continue; }
    if (c === delim) { row.push(field); field = ""; started = true; continue; }
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; started = false; continue; }
    if (c === "\r") continue;
    field += c;
    started = true;
  }
  if (started || field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/**
 * Which character separates the fields.
 *
 * Counting occurrences is not enough — a narrative full of commas beats a
 * semicolon-delimited file every time. What actually identifies a delimiter is
 * that it produces the *same* number of fields on every row, which is a
 * property no incidental character has.
 */
function sniffDelimiter(text: string): { ch: string; name: string } {
  let best = DELIMITERS[0];
  let bestScore = -1;
  for (const d of DELIMITERS) {
    const rows = splitCsv(text, d.ch).filter((r) => r.some((c) => c.trim() !== "")).slice(0, 30);
    if (rows.length === 0) continue;
    const widths = rows.map((r) => r.length);
    const common = widths.sort((a, b) => widths.filter((w) => w === a).length - widths.filter((w) => w === b).length).pop() as number;
    if (common < 2) continue;
    const agree = rows.filter((r) => r.length === common).length / rows.length;
    const score = agree * 100 + Math.min(common, 20);
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return best;
}

const normalise = (h: string) => h.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function scoreHeader(header: string, role: CsvRole): { score: number; phrase: string } | null {
  const n = normalise(header);
  if (!n) return null;
  let best: { score: number; phrase: string } | null = null;
  for (const phrase of ROLE_WORDS[role]) {
    if (!n.includes(phrase)) continue;
    const weight = n === phrase ? 3 : n.startsWith(phrase) || n.endsWith(phrase) ? 2 : 1;
    const score = phrase.length * weight;
    if (!best || score > best.score) best = { score, phrase };
  }
  return best;
}

function mapColumns(header: string[], headerRow: number, delim: { ch: string; name: string }): CsvMapping {
  // Each column claims the one role it fits best, then each role takes the
  // strongest column that claimed it. Doing it in that order stops "Value Date"
  // from being read as the posting date merely because it contains "date".
  const claims = new Map<CsvRole, { index: number; header: string; score: number }[]>();
  header.forEach((h, index) => {
    let winner: { role: CsvRole; score: number } | null = null;
    let tied = false;
    for (const role of Object.keys(ROLE_WORDS) as CsvRole[]) {
      const s = scoreHeader(h, role);
      if (!s) continue;
      if (!winner || s.score > winner.score) { winner = { role, score: s.score }; tied = false; }
      else if (s.score === winner.score) tied = true;
    }
    if (!winner || tied) return;
    const list = claims.get(winner.role) ?? [];
    list.push({ index, header: h, score: winner.score });
    claims.set(winner.role, list);
  });

  const columns: Partial<Record<CsvRole, number>> = {};
  const ambiguous: CsvMapping["ambiguous"] = [];
  for (const [role, list] of claims) {
    const top = Math.max(...list.map((c) => c.score));
    const winners = list.filter((c) => c.score === top);
    if (winners.length === 1) columns[role] = winners[0].index;
    else ambiguous.push({ role, candidates: winners.map((w) => ({ index: w.index, header: w.header })) });
  }

  // A role two columns fit equally well is unsettled, not absent. Keeping the
  // two apart matters: the first is a question for the user, the second means
  // this row is not the header row at all.
  const unsettled = new Set(ambiguous.map((a) => a.role));
  const missing: CsvRole[] = [];
  if (columns.date === undefined && columns.valueDate === undefined && !unsettled.has("date") && !unsettled.has("valueDate")) missing.push("date");
  if (columns.description === undefined && !unsettled.has("description")) missing.push("description");
  if (
    columns.amount === undefined &&
    (columns.debit === undefined || columns.credit === undefined) &&
    !unsettled.has("amount") && !unsettled.has("debit") && !unsettled.has("credit")
  ) missing.push("amount");

  return { delimiter: delim.ch, delimiterName: delim.name, headerRow, header, columns, ambiguous, missing };
}

/** The delimiter, the header row and what each column is. Nothing is read yet. */
export function sniffCsv(text: string): CsvMapping {
  const delim = sniffDelimiter(text);
  const rows = splitCsv(text, delim.ch);
  const limit = Math.min(rows.length, 15);
  let fallback: CsvMapping | null = null;
  for (let r = 0; r < limit; r++) {
    if (rows[r].every((c) => c.trim() === "")) continue;
    const mapping = mapColumns(rows[r].map((c) => c.trim()), r, delim);
    // Bank portals print the account number and the period above the headers,
    // so the first row is not reliably the header row; the header row is the
    // first one that actually names the columns a statement needs.
    if (mapping.missing.length === 0 && mapping.ambiguous.every((a) => a.role !== "date" && a.role !== "description")) return mapping;
    fallback ??= mapping;
  }
  return fallback ?? mapColumns(rows[0] ?? [], 0, delim);
}

function parseCsv(text: string, opts: ParseOptions): ParsedStatement {
  const sniffed = sniffCsv(text);
  const mapping: CsvMapping = opts.columns
    ? { ...sniffed, columns: { ...sniffed.columns, ...opts.columns }, ambiguous: [], missing: [] }
    : sniffed;

  if (!opts.columns) {
    const blocking = mapping.ambiguous.filter((a) => ["date", "description", "amount", "debit", "credit"].includes(a.role));
    if (blocking.length) {
      throw new BankFormatError(
        `More than one column could be the ${blocking.map((b) => `${b.role} (${b.candidates.map((c) => `"${c.header}"`).join(" or ")})`).join("; the ")}. ` +
          `Confirm which before anything is imported — a column read as the wrong one is a statement that is wrong everywhere.`,
        { mapping },
      );
    }
    if (mapping.missing.length) {
      throw new BankFormatError(
        `The header row does not name ${mapping.missing.join(", ")}. What was found was: ${mapping.header.map((h) => `"${h}"`).join(", ")}. ` +
          `Say which column is which rather than let this guess.`,
        { mapping },
      );
    }
  }

  if (opts.columns) {
    const named: CsvRole[] = [];
    if (mapping.columns.date === undefined && mapping.columns.valueDate === undefined) named.push("date");
    if (mapping.columns.description === undefined) named.push("description");
    if (mapping.columns.amount === undefined && (mapping.columns.debit === undefined || mapping.columns.credit === undefined)) named.push("amount");
    if (named.length) {
      throw new BankFormatError(
        `The columns you confirmed do not include ${named.join(" or ")}. A statement cannot be read without ${named.length === 1 ? "it" : "them"}.`,
        { mapping },
      );
    }
  }

  const warnings: string[] = [];
  for (const a of mapping.ambiguous) {
    warnings.push(`More than one column could be the ${a.role} (${a.candidates.map((c) => `"${c.header}"`).join(", ")}), so none was used.`);
  }

  const rows = splitCsv(text, mapping.delimiter);
  const col = mapping.columns;
  const dateCol = col.date ?? (col.valueDate as number);
  if (col.date === undefined && col.valueDate !== undefined) {
    warnings.push(`There is no posting date column, so the value date ("${mapping.header[col.valueDate]}") has been used as the date. A statement that books and values on different days will reconcile a day out.`);
  }

  let account: string | null = null;
  for (let r = 0; r < mapping.headerRow; r++) {
    const cells = rows[r] ?? [];
    for (let c = 0; c < cells.length; c++) {
      if (/account\s*(number|no|nbr|#)?\s*$/i.test(cells[c].replace(/[:\s]+$/, "")) && /account/i.test(cells[c])) {
        const value = cells.slice(c + 1).find((x) => x.trim() !== "");
        if (value) account = value.trim();
      }
    }
  }

  const currency = opts.currency ?? "AED";
  const exp = exponentOf(currency);

  interface Raw { row: number; date: string; description: string; reference?: string; amount: bigint; balance: bigint | null }
  const raws: Raw[] = [];

  for (let r = mapping.headerRow + 1; r < rows.length; r++) {
    const cells = rows[r];
    if (!cells || cells.every((c) => c.trim() === "")) continue;
    const cell = (i: number | undefined) => (i === undefined ? "" : (cells[i] ?? "").trim());

    const rawDate = cell(dateCol);
    const amountCells = [cell(col.amount), cell(col.debit), cell(col.credit)].filter((v) => v !== "");
    if (rawDate === "") {
      if (amountCells.length) warnings.push(`Row ${r + 1} has an amount but no date and has been left out.`);
      continue;
    }

    let amount: bigint | null;
    if (col.amount !== undefined) {
      amount = parseMinor(cell(col.amount), exp);
    } else {
      const dr = parseMinor(cell(col.debit) || "0", exp);
      const cr = parseMinor(cell(col.credit) || "0", exp);
      if (dr === null || cr === null) amount = null;
      else {
        // A debit column on a bank statement is money leaving the account; the
        // column carries the direction, so only the magnitude is taken from it.
        const drAbs = dr < 0n ? -dr : dr;
        const crAbs = cr < 0n ? -cr : cr;
        if (drAbs !== 0n && crAbs !== 0n) warnings.push(`Row ${r + 1} has figures in both the debit and the credit column; they have been netted.`);
        amount = crAbs - drAbs;
      }
    }
    if (amount === null) {
      warnings.push(`Row ${r + 1} has an amount that could not be read ("${[cell(col.amount), cell(col.debit), cell(col.credit)].filter(Boolean).join(" / ")}") and has been left out.`);
      continue;
    }
    if (amount === 0n) continue;

    const balance = col.balance === undefined || cell(col.balance) === "" ? null : parseMinor(cell(col.balance), exp);
    if (col.balance !== undefined && cell(col.balance) !== "" && balance === null) {
      warnings.push(`Row ${r + 1} has a balance that could not be read ("${cell(col.balance)}").`);
    }

    raws.push({
      row: r + 1,
      date: rawDate,
      description: tidy(cell(col.description)),
      reference: cell(col.reference) || undefined,
      amount,
      balance,
    });
  }

  if (raws.length === 0) throw new BankFormatError("No transaction rows were found below the header.");

  const verdict = detectDateOrder(raws.map((x) => x.date));
  const order = opts.dateOrder ?? verdict.order;
  if (!order) {
    throw new BankFormatError(
      `The dates in this file could be day-first or month-first and the file cannot settle it: ${verdict.why} ` +
        `Say which order the bank uses — guessing would move every line into the wrong month, and nothing downstream would look wrong.`,
      { samples: verdict.samples },
    );
  }
  if (opts.dateOrder && verdict.order && verdict.order !== opts.dateOrder) {
    warnings.push(`You chose ${opts.dateOrder}, but the file's own dates only fit ${verdict.order} (${verdict.why}).`);
  }

  const unread = raws.filter((x) => toIsoDate(x.date, order) === null);
  if (unread.length) {
    throw new BankFormatError(
      `Read as ${order}, ${unread.length === 1 ? "the date" : "these dates"} ${unread.slice(0, 3).map((u) => `"${u.date}" (row ${u.row})`).join(", ")} ${unread.length === 1 ? "is" : "are"} not real dates.`,
      { samples: unread.map((u) => u.date) },
    );
  }

  const rowsOut: Omit<ParsedLine, "fingerprint">[] = raws.map((x) => ({
    postedOn: toIsoDate(x.date, order) as string,
    description: x.description || "(no narrative)",
    reference: x.reference,
    amountMinor: x.amount.toString(),
    ...(x.balance === null ? {} : { balanceMinor: x.balance.toString() }),
  }));

  // A running balance column is what lets a CSV prove itself: the opening
  // balance is the first row's balance less its own movement, and every step
  // between must be explained by the line beside it. A row lifted out of the
  // middle of the file breaks that chain and then fails the footing.
  let opening: bigint | null = null;
  let closing: bigint | null = null;
  const withBalance = raws.filter((x) => x.balance !== null);
  if (withBalance.length === raws.length && raws.length > 0) {
    opening = (raws[0].balance as bigint) - raws[0].amount;
    closing = raws[raws.length - 1].balance as bigint;
    let running = opening;
    for (const x of raws) {
      running += x.amount;
      if (running !== x.balance) {
        warnings.push(`Row ${x.row} does not follow on from the balance above it — the running balance jumps by ${figure((x.balance as bigint) - running, currency)}. A row is missing from the file.`);
        running = x.balance as bigint;
      }
    }
  } else if (withBalance.length) {
    warnings.push("Only some rows carry a running balance, so the statement cannot be proved to foot.");
  }

  return finish({
    format: "CSV",
    account,
    statementNumber: null,
    currency,
    reference: null,
    dateOrder: order,
    opening, closing,
    rows: rowsOut,
    warnings,
    unprovable: "This CSV has no running balance column, so there is no figure of the bank's own to check the lines against. Export it again with the balance column if you can.",
  });
}

/* ------------------------------------------------------------- detection --- */

/**
 * Work out what arrived, and say what made it think so.
 *
 * The confidence is not a probability. It is how much of the file was actually
 * recognised, so that a low number is an invitation to look rather than a
 * reason to stop.
 */
export function detectFormat(text: string): FormatGuess {
  const head = text.slice(0, 200_000);
  const upper = head.toUpperCase();
  const saw: string[] = [];

  if (/<\s*[A-Za-z0-9]*:?Document\b/.test(head) || upper.includes("BKTOCSTMRSTMT")) {
    if (upper.includes("BKTOCSTMRSTMT")) saw.push("<BkToCstmrStmt>");
    if (/<\s*[A-Za-z0-9]*:?Stmt\b/.test(head)) saw.push("<Stmt>");
    if (upper.includes("CDTDBTIND")) saw.push("<CdtDbtInd>");
    if (upper.includes("<NTRY")) saw.push("<Ntry>");
    if (saw.length >= 2) return { format: "CAMT053", confidence: Math.min(95, 55 + saw.length * 12), saw };
  }

  if (upper.includes("OFXHEADER") || /<\s*OFX\b/.test(upper) || upper.includes("<STMTTRN>")) {
    if (upper.includes("OFXHEADER")) saw.push("OFXHEADER");
    if (upper.includes("<STMTTRN>")) saw.push("<STMTTRN>");
    if (upper.includes("<TRNAMT>")) saw.push("<TRNAMT>");
    if (upper.includes("<FITID>")) saw.push("<FITID>");
    return { format: "OFX", confidence: Math.min(95, 45 + saw.length * 15), saw };
  }

  const tags = ["20", "25", "28C", "60F", "61", "62F"].filter((t) => new RegExp(`^:${t}:`, "m").test(head));
  if (tags.length >= 2 && /^:61:/m.test(head)) {
    saw.push(...tags.map((t) => `:${t}:`));
    if (/^:86:/m.test(head)) saw.push(":86:");
    return { format: "MT940", confidence: Math.min(95, 40 + saw.length * 11), saw };
  }

  const mapping = sniffCsv(head);
  if (mapping.missing.length === 0) {
    saw.push(`${mapping.delimiterName}-separated`, `header on row ${mapping.headerRow + 1}`, ...Object.keys(mapping.columns).map((r) => `${r} column`));
    return { format: "CSV", confidence: Math.min(90, 40 + Object.keys(mapping.columns).length * 8), saw };
  }
  if (mapping.header.length > 1 && Object.keys(mapping.columns).length >= 2) {
    return {
      format: "CSV",
      confidence: 20,
      saw: [`${mapping.delimiterName}-separated`, `no column for ${mapping.missing.join(", ")}`],
    };
  }

  return { format: null, confidence: 0, saw: ["nothing recognisable: no SWIFT tags, no <BkToCstmrStmt>, no <STMTTRN>, no header row"] };
}

/* ----------------------------------------------------------- the door in --- */

/**
 * Parse a statement into the shape importStatement() takes.
 *
 * This is the only entry point. It detects the format unless told, refuses
 * anything it cannot vouch for, and returns the proof alongside the lines so
 * the decision to import is made by someone who can see whether the file adds
 * up.
 */
export function parseStatement(opts: ParseOptions): ParsedStatement {
  const text = opts.text ?? "";
  if (text.length > MAX_TEXT) {
    throw new BankFormatError(`This file is ${Math.round(text.length / 1_048_576)} MB, which is larger than any one statement. Split it by period.`);
  }
  if (text.trim() === "") throw new BankFormatError("There is nothing to read — paste or upload a statement first.");

  const guess = opts.format ? { format: opts.format, confidence: 100, saw: ["chosen by hand"] } : detectFormat(text);
  if (!guess.format) {
    throw new BankFormatError(
      "This does not look like MT940, CAMT.053, OFX or a statement CSV. If it is a CSV, it needs a header row naming at least a date, a description and an amount.",
    );
  }

  switch (guess.format) {
    case "MT940": return parseMt940(text, opts.currency);
    case "CAMT053": return parseCamt053(text, opts.currency);
    case "OFX": return parseOfx(text, opts.currency);
    case "CSV": return parseCsv(text, opts);
  }
}
