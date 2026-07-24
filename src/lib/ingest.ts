"use client";

import { parseMoneyToMinor } from "@/lib/domain/money";
import { recalc, makeDraft } from "@/lib/db/repo";
import { computeCompliance } from "@/lib/domain/validation";
import { derivePeppolId } from "@/lib/domain/peppol";
import type { Entity, Invoice, InvoiceLine, TaxProfileCode } from "@/lib/domain/types";
import { id as makeId } from "@/lib/utils";

/** Target fields the ingestor maps source columns onto. */
export const TARGET_FIELDS = [
  { key: "invoice_number", label: "Invoice number", aliases: ["invoice no", "inv no", "vch no", "number", "bill no", "رقم الفاتورة"] },
  { key: "issue_date", label: "Issue date", aliases: ["date", "invoice date", "issued", "التاريخ"] },
  { key: "customer_name", label: "Customer name", aliases: ["customer", "party", "party's name", "client", "buyer", "account", "اسم العميل"] },
  { key: "customer_trn", label: "Customer TRN", aliases: ["trn", "tax reg", "vat no", "gstin", "الرقم الضريبي"] },
  { key: "description", label: "Description", aliases: ["item", "particulars", "details", "product", "narration", "الوصف"] },
  { key: "qty", label: "Quantity", aliases: ["qty", "quantity", "units", "الكمية"] },
  { key: "unit_price", label: "Unit price", aliases: ["price", "rate", "unit price", "unit rate", "السعر"] },
  { key: "line_total", label: "Line total", aliases: ["amount", "total", "taxable value", "net", "line amount", "المبلغ"] },
  { key: "tax_rate", label: "Tax rate %", aliases: ["vat", "tax", "vat %", "tax rate", "vat rate", "الضريبة"] },
  { key: "currency", label: "Currency", aliases: ["currency", "curr", "ccy", "العملة"] },
] as const;

export type TargetKey = (typeof TARGET_FIELDS)[number]["key"];
export type Mapping = Partial<Record<TargetKey, number>>; // target → column index

export interface ParsedSheet {
  headers: string[];
  rows: string[][];
  fileName: string;
  sheetName?: string;
}

/* ---------------- Parsing ---------------- */

function sniffDelimiter(sample: string): string {
  const candidates = [",", ";", "\t", "|"];
  const firstLine = sample.split(/\r?\n/)[0] ?? "";
  let best = ",";
  let bestCount = -1;
  for (const d of candidates) {
    const count = firstLine.split(d).length;
    if (count > bestCount) {
      bestCount = count;
      best = d;
    }
  }
  return best;
}

/** Minimal RFC-4180-ish CSV parser with quote handling. */
function parseDelimited(text: string, delim: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === delim) {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c === "\r") {
      // skip; \n handles line end
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

export async function parseFile(file: File): Promise<ParsedSheet> {
  const name = file.name.toLowerCase();
  if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
    const XLSX = await import("xlsx");
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array" });
    // pick the densest sheet
    let best = wb.SheetNames[0];
    let bestRows = 0;
    for (const sn of wb.SheetNames) {
      const json = XLSX.utils.sheet_to_json<string[]>(wb.Sheets[sn], { header: 1, blankrows: false });
      if (json.length > bestRows) {
        bestRows = json.length;
        best = sn;
      }
    }
    const json = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[best], { header: 1, blankrows: false, raw: false });
    const all = json.map((r) => (r as unknown[]).map((c) => (c == null ? "" : String(c))));
    const headerIdx = findHeaderRow(all);
    return {
      headers: all[headerIdx] ?? [],
      rows: all.slice(headerIdx + 1),
      fileName: file.name,
      sheetName: best,
    };
  }
  // CSV / TSV
  const text = await file.text();
  const delim = name.endsWith(".tsv") ? "\t" : sniffDelimiter(text);
  const all = parseDelimited(text, delim);
  const headerIdx = findHeaderRow(all);
  return { headers: all[headerIdx] ?? [], rows: all.slice(headerIdx + 1), fileName: file.name };
}

/** Score rows to find the header (string-heavy, keyword hits). */
function findHeaderRow(rows: string[][]): number {
  const limit = Math.min(rows.length, 15);
  let best = 0;
  let bestScore = -1;
  const keywords = TARGET_FIELDS.flatMap((t) => [t.label.toLowerCase(), ...t.aliases]);
  for (let i = 0; i < limit; i++) {
    const cells = rows[i].map((c) => c.trim().toLowerCase());
    if (cells.filter(Boolean).length < 2) continue;
    const stringy = cells.filter((c) => c && Number.isNaN(Number(c))).length;
    const hits = cells.filter((c) => keywords.some((k) => c.includes(k))).length;
    const score = stringy + hits * 3;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

/* ---------------- Auto mapping ---------------- */

export function guessMapping(headers: string[]): Mapping {
  const mapping: Mapping = {};
  const used = new Set<number>();
  headers.forEach((h, idx) => {
    const norm = h.trim().toLowerCase();
    for (const target of TARGET_FIELDS) {
      if (mapping[target.key] != null) continue;
      const match =
        norm === target.label.toLowerCase() ||
        target.aliases.some((a) => norm === a || norm.includes(a));
      if (match && !used.has(idx)) {
        mapping[target.key] = idx;
        used.add(idx);
        break;
      }
    }
  });
  return mapping;
}

/* ---------------- Row → Invoice ---------------- */

function parseDateSmart(raw: string): string {
  const s = raw.trim();
  if (!s) return new Date().toISOString().slice(0, 10);
  // ISO
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  // dd/mm/yyyy or dd-mm-yyyy (UAE default)
  const m = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/);
  if (m) {
    let [, a, b, y] = m;
    if (y.length === 2) y = "20" + y;
    const day = a.padStart(2, "0");
    const month = b.padStart(2, "0");
    return `${y}-${month}-${day}`;
  }
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return new Date().toISOString().slice(0, 10);
}

function parseRate(raw: string): TaxProfileCode {
  const n = Number(raw.replace(/[^\d.]/g, ""));
  if (Number.isNaN(n)) return "STANDARD_5";
  if (n === 0) return "ZERO_OTHER";
  return "STANDARD_5";
}

export interface BuiltRow {
  rowNo: number;
  invoice: Invoice;
  raw: string[];
}

export function buildInvoiceFromRow(
  entity: Entity,
  mapping: Mapping,
  raw: string[],
  rowNo: number,
): BuiltRow {
  const get = (k: TargetKey): string => {
    const idx = mapping[k];
    return idx != null ? (raw[idx] ?? "").trim() : "";
  };

  const draft = makeDraft(entity, { number: get("invoice_number") || `IMP-${rowNo}` });
  draft.source = "INGEST";
  const currency = get("currency").toUpperCase() || entity.defaultCurrency;
  draft.currency = /^[A-Z]{3}$/.test(currency) ? currency : entity.defaultCurrency;

  const issue = parseDateSmart(get("issue_date"));
  draft.issueDate = issue;
  draft.supplyDate = issue;

  const trn = get("customer_trn").replace(/\D/g, "");
  draft.buyer = {
    nameEn: get("customer_name") || "Unnamed customer",
    trn: trn.length >= 10 ? trn : undefined,
    peppolId: trn.length >= 10 ? derivePeppolId(trn) : undefined,
  };

  const qty = Number(get("qty").replace(/[^\d.]/g, "")) || 1;
  let unitPriceMinor = parseMoneyToMinor(get("unit_price"));
  const lineTotal = parseMoneyToMinor(get("line_total"));
  if (!unitPriceMinor && lineTotal) unitPriceMinor = Math.round(lineTotal / qty);

  const line: InvoiceLine = {
    id: makeId("ln"),
    lineNo: 1,
    description: get("description") || "Imported line",
    qty,
    unitCode: "C62",
    unitPriceMinor,
    taxProfileCode: parseRate(get("tax_rate")),
    lineNetMinor: 0,
    lineVatMinor: 0,
  };
  draft.lines = [line];
  draft.compliance = computeCompliance(draft.supplyDate);

  return { rowNo, invoice: recalc(draft), raw };
}
