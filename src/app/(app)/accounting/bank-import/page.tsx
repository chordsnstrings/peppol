"use client";

import * as React from "react";
import Link from "next/link";
import { api, ApiError, useEntityId } from "@/components/ledger/use-ledger";
import { Figure, PageHead, Panel, ErrorNote, Empty } from "@/components/ledger/primitives";

/* The wire shapes of /api/ledger/bank-import. Declared here rather than
   imported so the parser — which reaches the database through the importer's
   fingerprint function — never follows a type into the client bundle. */
interface ParsedLine {
  postedOn: string;
  valueDate?: string;
  description: string;
  reference?: string;
  amountMinor: string;
  balanceMinor?: string;
  kind?: string;
  reversal?: boolean;
  fingerprint: string;
}
interface FootingProof {
  provable: boolean;
  openingMinor: string | null;
  closingMinor: string | null;
  sumMinor: string;
  expectedClosingMinor: string | null;
  differenceMinor: string | null;
  foots: boolean;
  lineCount: number;
  note: string;
}
interface ParsedStatement {
  format: string;
  account: string | null;
  statementNumber: string | null;
  currency: string | null;
  reference: string | null;
  dateOrder: string | null;
  openingMinor: string | null;
  closingMinor: string | null;
  lines: ParsedLine[];
  proof: FootingProof;
  warnings: string[];
}
interface CsvMapping {
  delimiter: string;
  delimiterName: string;
  headerRow: number;
  header: string[];
  columns: Record<string, number | undefined>;
  ambiguous: { role: string; candidates: { index: number; header: string }[] }[];
  missing: string[];
}
interface ParseReply {
  detected: { format: string | null; confidence: number; saw: string[] };
  statement: ParsedStatement;
}

/**
 * A refusal from the parser, with what it needs to be told.
 *
 * The shared api() helper keeps only the message, and the message alone is a
 * dead end here: when the sniffer cannot settle which column is which, the
 * mapping it did work out is the whole fix. So this one call is made directly.
 */
class ParseRefusal extends Error {
  constructor(message: string, readonly detail: { mapping?: CsvMapping; samples?: string[]; missing?: string[] }) {
    super(message);
    this.name = "ParseRefusal";
  }
}

async function readStatement(body: Record<string, unknown>): Promise<ParseReply> {
  const res = await fetch("/api/ledger/bank-import", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Partial<ParseReply> & {
    error?: string;
    detail?: { mapping?: CsvMapping; samples?: string[]; missing?: string[] };
  };
  if (!res.ok) throw new ParseRefusal(json.error ?? `That file could not be read (${res.status}).`, json.detail ?? {});
  return json as ParseReply;
}

const FORMATS = [
  { value: "", label: "Detect from the file" },
  { value: "MT940", label: "MT940 (SWIFT)" },
  { value: "CAMT053", label: "CAMT.053 (ISO 20022)" },
  { value: "OFX", label: "OFX / QFX" },
  { value: "CSV", label: "CSV" },
];

const ORDERS = [
  { value: "", label: "Settle it from the dates" },
  { value: "DMY", label: "Day first — 03/04 is 3 April" },
  { value: "MDY", label: "Month first — 03/04 is 4 March" },
  { value: "YMD", label: "Year first — 2026-04-03" },
];

/** The roles a CSV column can fill, in the order a statement reads. */
const ROLES: { key: string; label: string; needed?: boolean }[] = [
  { key: "date", label: "Date", needed: true },
  { key: "valueDate", label: "Value date" },
  { key: "description", label: "Description", needed: true },
  { key: "reference", label: "Reference" },
  { key: "amount", label: "Amount (signed)" },
  { key: "debit", label: "Debit (money out)" },
  { key: "credit", label: "Credit (money in)" },
  { key: "balance", label: "Balance" },
];

export default function BankImportPage() {
  const entityId = useEntityId();
  const [text, setText] = React.useState("");
  const [fileName, setFileName] = React.useState<string | null>(null);
  const [format, setFormat] = React.useState("");
  const [dateOrder, setDateOrder] = React.useState("");
  const [account, setAccount] = React.useState("1010");
  const [batch, setBatch] = React.useState("");
  const [columns, setColumns] = React.useState<Record<string, string>>({});

  const [busy, setBusy] = React.useState<"parse" | "import" | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [mapping, setMapping] = React.useState<CsvMapping | null>(null);
  const [reply, setReply] = React.useState<ParseReply | null>(null);
  const [note, setNote] = React.useState<string | null>(null);
  const [anyway, setAnyway] = React.useState(false);

  const fileRef = React.useRef<HTMLInputElement>(null);

  const st = reply?.statement;
  const currency = st?.currency ?? "AED";

  const onFile = async (f: File) => {
    setFileName(f.name);
    setError(null);
    setText(await f.text());
    setReply(null);
    setMapping(null);
    setNote(null);
  };

  const parse = async (withColumns?: Record<string, string>) => {
    setBusy("parse");
    setError(null);
    setNote(null);
    setReply(null);
    setAnyway(false);
    try {
      const cols = withColumns ?? (mapping ? columns : undefined);
      const r = await readStatement({
        text,
        format: format || undefined,
        dateOrder: dateOrder || undefined,
        columns: cols && Object.keys(cols).length ? cols : undefined,
      });
      setReply(r);
      setMapping(null);
      setBatch(defaultBatch(r.statement));
      setNote(
        `Read ${r.statement.lines.length} line${r.statement.lines.length === 1 ? "" : "s"} as ${label(r.statement.format)}. ` +
          (r.statement.proof.foots
            ? "The lines foot to the statement's own closing balance."
            : r.statement.proof.provable
              ? "The lines do not foot to the statement's own closing balance."
              : "The file gives nothing to check the lines against."),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "That file could not be read.");
      const m = e instanceof ParseRefusal ? e.detail.mapping ?? null : null;
      if (m) {
        setMapping(m);
        const seed: Record<string, string> = {};
        for (const [role, index] of Object.entries(m.columns)) if (index !== undefined) seed[role] = String(index);
        setColumns(seed);
      }
    } finally {
      setBusy(null);
    }
  };

  const doImport = async () => {
    if (!st || !entityId) return;
    setBusy("import");
    setError(null);
    try {
      const r = await api<{ imported: number; duplicates: number; total: number; batch: string }>("/api/ledger/bank", {
        method: "POST",
        body: JSON.stringify({
          action: "import",
          entityId,
          account,
          batch: batch || undefined,
          lines: st.lines.map((l) => ({
            postedOn: l.postedOn,
            description: l.description,
            reference: l.reference,
            amountMinor: l.amountMinor,
            balanceMinor: l.balanceMinor,
          })),
        }),
      });
      setNote(
        `Imported ${r.imported} line${r.imported === 1 ? "" : "s"} into ${account} as batch ${r.batch}` +
          (r.duplicates > 0 ? `, skipping ${r.duplicates} already on file.` : "."),
      );
      setReply(null);
      setText("");
      setFileName(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "That import did not go through.");
    } finally {
      setBusy(null);
    }
  };

  const blocked = Boolean(st && st.proof.provable && !st.proof.foots && !anyway);

  return (
    <>
      <PageHead
        title="Import a bank statement"
        sub="MT940, CAMT.053, OFX and whatever CSV the portal produced, read into the same lines the reconciliation uses. Nothing is written down until the file has proved that its lines add up to its own closing balance."
        actions={<Link href="/accounting/bank" className="sw-btn">Reconciliation</Link>}
      />

      {error && <ErrorNote>{error}</ErrorNote>}
      {note && !error && <div className="sw-note mb-3" role="status" aria-live="polite">{note}</div>}

      <Panel className="mb-4 p-4">
        <div className="sw-label">The file</div>
        <p className="sw-sub mt-1 max-w-[72ch]">
          Paste it, or choose the file the bank gave you. Nothing about it is assumed: the format is
          sniffed, the columns of a CSV are found by name, and where a date could be read two ways this
          says so and asks rather than picking one.
        </p>

        <label className="sr-only" htmlFor="statement-text">Statement text</label>
        <textarea
          id="statement-text"
          className="sw-input mt-2"
          rows={8}
          spellCheck={false}
          style={{ fontFamily: "var(--sw-font-mono)", fontSize: "0.75rem" }}
          placeholder={":20:STMT260630\n:25:AE070331234567890123456\n:60F:C260531AED1250000,00\n:61:2606010601C25000,00NTRFINV2026118//FT26152A1B2C\n:86:INWARD TT ACME TRADING LLC"}
          value={text}
          onChange={(e) => { setText(e.target.value); setReply(null); setMapping(null); }}
        />

        <div className="mt-3 flex flex-wrap items-end gap-3">
          <div>
            <input
              ref={fileRef}
              type="file"
              className="sr-only"
              accept=".txt,.sta,.940,.mt940,.xml,.camt,.ofx,.qfx,.csv,.tsv,text/plain,text/csv,application/xml"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFile(f); }}
              aria-label="Statement file"
            />
            <button type="button" className="sw-btn" onClick={() => fileRef.current?.click()}>
              Choose a file…
            </button>
            {fileName && <span className="sw-sub ml-2">{fileName}</span>}
          </div>

          <Field label="Format" htmlFor="fmt">
            <select id="fmt" className="sw-select sw-select-sm" value={format} onChange={(e) => setFormat(e.target.value)}>
              {FORMATS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
            </select>
          </Field>

          <Field label="Date order" htmlFor="ord">
            <select id="ord" className="sw-select sw-select-sm" value={dateOrder} onChange={(e) => setDateOrder(e.target.value)}>
              {ORDERS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </Field>

          <button
            type="button"
            className="sw-btn sw-btn-primary"
            onClick={() => void parse()}
            aria-disabled={!text.trim() || busy === "parse" || undefined}
            disabled={!text.trim() || busy === "parse"}
            data-testid="parse-statement"
          >
            {busy === "parse" ? "Reading…" : "Read the statement"}
          </button>
        </div>
      </Panel>

      {mapping && (
        <Panel className="mb-4 p-4">
          <div className="sw-label">Which column is which</div>
          <p className="sw-sub mt-1 max-w-[72ch]">
            The header row on line {mapping.headerRow + 1} was read as {mapping.delimiterName}-separated, and
            more than one column fitted. Say which is which — a column read as the wrong one is a statement
            that is wrong everywhere, and quietly.
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {ROLES.map((role) => (
              <Field key={role.key} label={role.label + (role.needed ? " *" : "")} htmlFor={`col-${role.key}`}>
                <select
                  id={`col-${role.key}`}
                  className="sw-select sw-select-sm"
                  value={columns[role.key] ?? ""}
                  onChange={(e) => setColumns((c) => ({ ...c, [role.key]: e.target.value }))}
                >
                  <option value="">— not in this file —</option>
                  {mapping.header.map((h, i) => (
                    <option key={i} value={i}>{i + 1}. {h || "(unnamed)"}</option>
                  ))}
                </select>
              </Field>
            ))}
          </div>
          <button
            type="button"
            className="sw-btn sw-btn-primary mt-3"
            onClick={() => void parse(columns)}
            disabled={busy === "parse"}
          >
            {busy === "parse" ? "Reading…" : "Read it with these columns"}
          </button>
        </Panel>
      )}

      {st && reply && (
        <>
          <div className="mb-4 grid gap-4 lg:grid-cols-2">
            <Panel className="p-4">
              <div className="sw-label">What was read</div>
              <table className="sw-table mt-3">
                <caption className="sr-only">What the file declared about itself</caption>
                <tbody>
                  <Fact label="Format">
                    <span className="sw-chip sw-chip-accent">{label(st.format)}</span>
                    <span className="sw-sub ml-2">
                      {reply.detected.format === st.format
                        ? `${reply.detected.confidence}% — ${reply.detected.saw.slice(0, 4).join(", ")}`
                        : "chosen by hand"}
                    </span>
                  </Fact>
                  <Fact label="Account">{st.account ?? <span className="sw-zero">not stated</span>}</Fact>
                  <Fact label="Statement">{st.statementNumber ?? st.reference ?? <span className="sw-zero">not numbered</span>}</Fact>
                  <Fact label="Currency">{st.currency ?? <span className="sw-zero">not stated</span>}</Fact>
                  <Fact label="Dates read as">{st.dateOrder ?? <span className="sw-zero">–</span>}</Fact>
                  <Fact label="Lines">{st.lines.length}</Fact>
                </tbody>
              </table>
            </Panel>

            <Panel className="p-4">
              <div className="sw-label">Does it add up</div>
              <table className="sw-table mt-3">
                <caption className="sr-only">The opening balance, the lines and the closing balance</caption>
                <tbody>
                  <Money label="Opening balance, per the file" minor={st.proof.openingMinor} currency={currency} />
                  <Money label={`The ${st.proof.lineCount} lines below`} minor={st.proof.sumMinor} currency={currency} />
                  <Money label="Which should close at" minor={st.proof.expectedClosingMinor} currency={currency} strong />
                  <Money label="Closing balance, per the file" minor={st.proof.closingMinor} currency={currency} />
                  <Money label="Difference" minor={st.proof.differenceMinor} currency={currency} strong />
                </tbody>
              </table>
              <p className="sw-sub mt-3" data-testid="proof-note">
                <span className={`sw-chip ${st.proof.foots ? "sw-chip-ok" : st.proof.provable ? "sw-chip-bad" : "sw-chip-warn"}`}>
                  {st.proof.foots ? "foots" : st.proof.provable ? "does not foot" : "unproven"}
                </span>{" "}
                {st.proof.note}
              </p>
            </Panel>
          </div>

          {st.warnings.length > 0 && (
            <Panel className="mb-4 p-4">
              <div className="sw-label">Worth reading before you import</div>
              <ul className="sw-sub mt-2 list-disc space-y-1 ps-5">
                {st.warnings.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            </Panel>
          )}

          <Panel className="mb-4 overflow-hidden">
            <div className="border-b px-3 py-2" style={{ borderColor: "var(--sw-line)", background: "var(--sw-surface-2)" }}>
              <span className="sw-label">The lines, as they will be imported</span>
            </div>
            {st.lines.length === 0 ? (
              <div className="p-3"><Empty>The file declared balances but carried no transactions.</Empty></div>
            ) : (
              <div className="sw-scroll">
                <table className="sw-table">
                  <caption className="sr-only">Every line parsed out of the statement</caption>
                  <thead>
                    <tr>
                      <th style={{ width: "6.5rem" }}>Date</th>
                      <th style={{ width: "6.5rem" }}>Value date</th>
                      <th>Description</th>
                      <th style={{ width: "9rem" }}>Reference</th>
                      <th style={{ width: "5rem" }}>Type</th>
                      <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Amount</th>
                      <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Balance</th>
                      <th style={{ width: "6rem" }}>Identity</th>
                    </tr>
                  </thead>
                  <tbody>
                    {st.lines.map((l, i) => (
                      // Two lines a bank described identically share a
                      // fingerprint, so position is what keeps them apart here.
                      <tr key={`${i}-${l.fingerprint}`}>
                        <td>{l.postedOn}</td>
                        <td>{l.valueDate && l.valueDate !== l.postedOn ? l.valueDate : <span className="sw-zero">–</span>}</td>
                        <td className="max-w-0 truncate" title={l.description}>
                          {l.description}
                          {l.reversal && <span className="sw-chip sw-chip-warn ms-2">reversal</span>}
                        </td>
                        <td className="sw-code max-w-0 truncate" title={l.reference ?? ""}>
                          {l.reference ?? <span className="sw-zero">–</span>}
                        </td>
                        <td className="sw-code">{l.kind ?? <span className="sw-zero">–</span>}</td>
                        <td className="sw-num"><Figure minor={l.amountMinor} currency={currency} /></td>
                        <td className="sw-num">
                          {l.balanceMinor === undefined
                            ? <span className="sw-zero">–</span>
                            : <Figure minor={l.balanceMinor} currency={currency} colour={false} zero="zero" />}
                        </td>
                        <td className="sw-code" title={l.fingerprint}>{l.fingerprint.slice(0, 8)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colSpan={5}>Movement</td>
                      <td className="sw-num"><Figure minor={st.proof.sumMinor} currency={currency} zero="zero" /></td>
                      <td colSpan={2} />
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </Panel>

          <Panel className="mb-4 p-4">
            <div className="sw-label">Hand it to the importer</div>
            <p className="sw-sub mt-1 max-w-[72ch]">
              The lines go to the same importer a pasted statement uses, so anything already on file is
              skipped rather than duplicated. The identity column above is the fingerprint that decides it.
            </p>
            <div className="mt-3 flex flex-wrap items-end gap-3">
              <Field label="Bank account code" htmlFor="acct">
                <input id="acct" className="sw-input sw-input-sm" style={{ width: "7rem" }} value={account}
                  onChange={(e) => setAccount(e.target.value)} />
              </Field>
              <Field label="Batch name" htmlFor="batch">
                <input id="batch" className="sw-input sw-input-sm" style={{ width: "16rem" }} value={batch}
                  onChange={(e) => setBatch(e.target.value)} />
              </Field>
              <button
                type="button"
                className="sw-btn sw-btn-primary"
                onClick={() => void doImport()}
                aria-disabled={blocked || busy === "import" || !entityId || undefined}
                disabled={blocked || busy === "import" || !entityId}
                data-testid="import-parsed"
              >
                {busy === "import" ? "Importing…" : `Import ${st.lines.length} line${st.lines.length === 1 ? "" : "s"}`}
              </button>
            </div>

            {st.proof.provable && !st.proof.foots && (
              <label className="sw-sub mt-3 flex items-start gap-2" style={{ color: "var(--sw-neg)" }}>
                <input type="checkbox" className="mt-0.5" checked={anyway} onChange={(e) => setAnyway(e.target.checked)} />
                <span>
                  This file does not add up to its own closing balance — it is out by{" "}
                  <Figure minor={st.proof.differenceMinor} currency={currency} zero="zero" />. Import it anyway,
                  knowing the reconciliation will be out by that amount until the missing lines are found.
                </span>
              </label>
            )}
            {!entityId && <p className="sw-sub mt-2">Choose an entity first.</p>}
          </Panel>
        </>
      )}
    </>
  );
}

function defaultBatch(st: ParsedStatement): string {
  const stamp = st.lines[0]?.postedOn.slice(0, 7) ?? new Date().toISOString().slice(0, 7);
  const name = st.statementNumber ?? st.reference ?? stamp;
  return `${st.format.toLowerCase()}-${name}`.replace(/[^a-z0-9-]+/gi, "-").toLowerCase().slice(0, 60);
}

function label(format: string): string {
  return format === "CAMT053" ? "CAMT.053" : format === "OFX" ? "OFX / QFX" : format;
}

function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: React.ReactNode }) {
  return (
    <span className="block">
      <label className="sw-label block" htmlFor={htmlFor}>{label}</label>
      <span className="mt-1 block">{children}</span>
    </span>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <tr>
      <th scope="row" style={{ textAlign: "start", fontWeight: 400, width: "12rem" }}>{label}</th>
      <td>{children}</td>
    </tr>
  );
}

function Money({ label, minor, currency, strong }: { label: string; minor: string | null; currency: string; strong?: boolean }) {
  return (
    <tr>
      <th scope="row" style={{ textAlign: "start", fontWeight: strong ? 600 : 400 }}>{label}</th>
      <td className="sw-num" style={{ width: "var(--sw-col-amount)", fontWeight: strong ? 600 : 400 }}>
        {minor === null ? <span className="sw-zero">not declared</span> : <Figure minor={minor} currency={currency} zero="zero" />}
      </td>
    </tr>
  );
}
