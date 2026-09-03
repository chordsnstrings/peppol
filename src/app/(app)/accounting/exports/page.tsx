"use client";

import * as React from "react";
import Link from "next/link";
import { api, ApiError, useEntityId } from "@/components/ledger/use-ledger";
import { Figure, PageHead, Panel, ErrorNote, Loading } from "@/components/ledger/primitives";

/* The wire shapes. Every amount arrives as a string of minor units. */

interface TableSummary { key: string; label: string; rowCount: number; columns: string[]; note: string }
interface TrialBalanceRow { code: string; name: string; debitMinor: string; creditMinor: string; balanceMinor: string }
interface Manifest {
  formatVersion: string;
  format: "csv" | "json";
  entityId: string;
  currency: string;
  from: string | null;
  to: string;
  generatedAt: string;
  tables: TableSummary[];
  totals: {
    entryCount: number;
    lineCount: number;
    totalDebitMinor: string;
    totalCreditMinor: string;
    trialBalanceAsOf: string;
    trialBalance: TrialBalanceRow[];
    trialBalanceDebitMinor: string;
    trialBalanceCreditMinor: string;
    trialBalanceDifferenceMinor: string;
    trialBalanceBalanced: boolean;
  };
  digestAlgorithm: string;
  digest: string;
}
interface ExportFile { key: string; name: string; contentType: string; content: string; rowCount: number | null }
interface Check { key: string; label: string; expected: string; actual: string; agrees: boolean; note: string }
interface Verification { intact: boolean; digest: string; recomputedDigest: string; checks: Check[]; problems: string[] }
interface Bundle {
  entityId: string; format: "csv" | "json"; from: string | null; to: string;
  currency: string; generatedAt: string; baseName: string;
  manifest: Manifest; files: ExportFile[]; warnings: string[]; verification: Verification;
}

interface ImportRow {
  accountCode: string; accountName: string | null;
  debitMinor: string; creditMinor: string;
  exists: boolean; postable: boolean; problem: string | null;
}
interface ImportPlan {
  entityId: string; asOf: string; currency: string;
  rows: ImportRow[];
  totalDebitMinor: string; totalCreditMinor: string; differenceMinor: string; balanced: boolean;
  unknownAccounts: string[]; blockers: string[]; linesToPost: number;
  doesNotCarry: string[]; order: string[];
  alreadyImported: boolean; reference: string | null; entryId: string | null; applied: boolean;
}

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Getting the books out, and bringing somebody else's in.
 *
 * The export shows its manifest before it hands anybody a file, because an
 * export nobody can check is an export nobody should trust. The import shows
 * what it would do before it does it, and says plainly what a trial balance
 * does not carry with it — which is the part every migration discovers too
 * late.
 */
export default function ExportsPage() {
  const entityId = useEntityId();

  const [from, setFrom] = React.useState("");
  const [to, setTo] = React.useState(today);
  const [format, setFormat] = React.useState<"csv" | "json">("csv");
  const [bundle, setBundle] = React.useState<Bundle | null>(null);
  const [exportErr, setExportErr] = React.useState<string | null>(null);
  const [exportMsg, setExportMsg] = React.useState<string | null>(null);
  const [building, setBuilding] = React.useState(false);

  const [asOf, setAsOf] = React.useState(() => `${new Date().getUTCFullYear() - 1}-12-31`);
  const [text, setText] = React.useState("");
  const [parseProblems, setParseProblems] = React.useState<string[]>([]);
  const [plan, setPlan] = React.useState<ImportPlan | null>(null);
  const [importErr, setImportErr] = React.useState<string | null>(null);
  const [importMsg, setImportMsg] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);

  const build = async () => {
    setBuilding(true);
    setExportErr(null);
    setExportMsg(null);
    try {
      const q = new URLSearchParams({ entityId: entityId ?? "", format, to });
      if (from) q.set("from", from);
      const b = await api<Bundle>(`/api/ledger/exports?${q.toString()}`);
      setBundle(b);
      setExportMsg(
        `${b.manifest.totals.lineCount} journal lines across ${b.manifest.tables.length} tables. ` +
          (b.verification.intact
            ? "The manifest agrees with the rows."
            : "The manifest does not agree with the rows — read the checks before downloading."),
      );
    } catch (e) {
      setBundle(null);
      setExportErr(e instanceof ApiError ? e.message : "The export could not be built.");
    }
    setBuilding(false);
  };

  // The bytes are already here, verified, and shown. Saving them from memory
  // rather than fetching them again is what makes the file on disk the same
  // file the manifest above describes — the mechanism the payroll WPS file and
  // the payment-run bank file already use.
  const download = (file: ExportFile) => {
    if (!bundle) return;
    const url = URL.createObjectURL(new Blob([file.content], { type: file.contentType }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${bundle.baseName}-${file.name}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const callImport = async <T,>(body: Record<string, unknown>): Promise<T | null> => {
    setImportErr(null);
    try {
      return await api<T>("/api/ledger/exports", { method: "POST", body: JSON.stringify({ entityId, ...body }) });
    } catch (e) {
      setImportErr(e instanceof ApiError ? e.message : "That did not work.");
      return null;
    }
  };

  const check = async () => {
    setBusy("check");
    setImportMsg(null);
    const parsed = await callImport<{ lines: unknown[]; problems: string[] }>({ action: "parse", text });
    if (!parsed) { setBusy(null); return; }
    setParseProblems(parsed.problems);
    if (parsed.lines.length === 0) { setPlan(null); setBusy(null); return; }
    setPlan(await callImport<ImportPlan>({ action: "preview", asOf, rows: parsed.lines }));
    setBusy(null);
  };

  const runImport = async () => {
    setBusy("import");
    setImportMsg(null);
    const parsed = await callImport<{ lines: unknown[] }>({ action: "parse", text });
    if (!parsed) { setBusy(null); return; }
    const r = await callImport<ImportPlan>({ action: "import", asOf, rows: parsed.lines });
    if (r) {
      setPlan(r);
      setImportMsg(
        r.alreadyImported
          ? `An opening position for ${r.asOf} already exists as ${r.reference}. Nothing was posted a second time.`
          : `Brought in ${r.linesToPost} balances as ${r.reference}. Load the registers next if you have not already.`,
      );
    }
    setBusy(null);
  };

  if (!entityId) return <Loading label="Choosing an entity…" />;

  const canImport = plan && plan.balanced && plan.blockers.length === 0 && !plan.alreadyImported;
  const failing = bundle?.verification.checks.filter((c) => !c.agrees) ?? [];

  return (
    <>
      <PageHead
        title="Export and migration"
        sub="Your books are yours. Take them out for an auditor, for another product, or simply to keep a copy — and bring in what you kept in whatever you used before."
      />

      {/* ------------------------------------------------------ the export */}

      <section aria-labelledby="export-heading" className="mb-8">
        <h2 id="export-heading" className="sw-label mb-2">Take the books out</h2>

        <Panel className="mb-3 p-4">
          <div className="flex flex-wrap items-end gap-3">
            <label className="grid gap-1">
              <span className="sw-label">From</span>
              <input
                type="date"
                className="sw-input"
                style={{ width: "9.5rem" }}
                value={from}
                onChange={(e) => { setFrom(e.target.value); setBundle(null); }}
                aria-label="Export journals from"
              />
            </label>
            <label className="grid gap-1">
              <span className="sw-label">To</span>
              <input
                type="date"
                className="sw-input"
                style={{ width: "9.5rem" }}
                value={to}
                onChange={(e) => { setTo(e.target.value); setBundle(null); }}
                aria-label="Export journals to"
              />
            </label>
            <label className="grid gap-1">
              <span className="sw-label">Format</span>
              <select
                className="sw-select"
                style={{ width: "16rem" }}
                value={format}
                onChange={(e) => { setFormat(e.target.value as "csv" | "json"); setBundle(null); }}
                aria-label="Export format"
                data-testid="export-format"
              >
                <option value="csv">CSV — one file per table</option>
                <option value="json">JSON — a single document</option>
              </select>
            </label>
            <button
              type="button"
              className="sw-btn sw-btn-primary"
              onClick={build}
              aria-disabled={building || undefined}
              disabled={building}
              data-testid="build-export"
            >
              {building ? "Building…" : "Build the export"}
            </button>
          </div>
          <p className="sw-sub mt-3 max-w-[76ch]">
            Leave <em>From</em> empty to export from the beginning of the books. The chart of accounts, the fiscal
            years and periods, every posted and reversed journal with its lines and dimensions, and the subledger
            registers — fixed assets, leases, inventory and counterparties. Amounts are whole minor units as text,
            never decimals and never numbers: past about ninety trillion fils a JSON number silently rounds, and an
            export that loses a fil is worse than no export because it will be believed.
          </p>
        </Panel>

        {exportErr && <ErrorNote>{exportErr}</ErrorNote>}
        {exportMsg && <div className="sw-note mb-3" role="status" data-testid="export-status">{exportMsg}</div>}

        {bundle && (
          <>
            <Panel className="mb-3 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="max-w-[62ch]">
                  <div className="sw-label">Manifest</div>
                  <p className="sw-sub mt-1">
                    {bundle.manifest.entityId} · {bundle.manifest.from ?? "the beginning of the books"} to{" "}
                    {bundle.manifest.to} · {bundle.manifest.currency} · {bundle.manifest.totals.entryCount} entries ·{" "}
                    {bundle.manifest.totals.lineCount} lines · layout {bundle.manifest.formatVersion}
                  </p>
                  <p className="sw-sub mt-1">
                    Built {bundle.manifest.generatedAt} · {bundle.manifest.digestAlgorithm}{" "}
                    <span className="sw-code" data-testid="export-digest" style={{ fontFamily: "var(--sw-font-mono)" }}>
                      {bundle.manifest.digest.slice(0, 32)}…
                    </span>
                  </p>
                </div>
                <span
                  className={`sw-chip ${bundle.verification.intact ? "sw-chip-ok" : "sw-chip-bad"}`}
                  data-testid="export-intact"
                >
                  {bundle.verification.intact ? "manifest agrees with the rows" : "manifest does not agree"}
                </span>
              </div>

              <div className="sw-scroll mt-3">
                <table className="sw-table">
                  <caption className="sr-only">Totals that must survive the round trip</caption>
                  <thead>
                    <tr>
                      <th>Figure the export has to reproduce</th>
                      <th className="sw-col-debit sw-num" style={{ width: "var(--sw-col-amount)" }}>Debit</th>
                      <th className="sw-col-credit sw-num" style={{ width: "var(--sw-col-amount)" }}>Credit</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <th scope="row">Journal lines in the range</th>
                      <td className="sw-num" data-testid="export-total-debit">
                        <Figure minor={bundle.manifest.totals.totalDebitMinor} currency={bundle.currency} zero="zero" colour={false} />
                      </td>
                      <td className="sw-num" data-testid="export-total-credit">
                        <Figure minor={bundle.manifest.totals.totalCreditMinor} currency={bundle.currency} zero="zero" colour={false} />
                      </td>
                    </tr>
                    <tr>
                      <th scope="row">Trial balance at {bundle.manifest.totals.trialBalanceAsOf}</th>
                      <td className="sw-num" data-testid="export-tb-debit">
                        <Figure minor={bundle.manifest.totals.trialBalanceDebitMinor} currency={bundle.currency} zero="zero" colour={false} />
                      </td>
                      <td className="sw-num" data-testid="export-tb-credit">
                        <Figure minor={bundle.manifest.totals.trialBalanceCreditMinor} currency={bundle.currency} zero="zero" colour={false} />
                      </td>
                    </tr>
                  </tbody>
                  <tfoot>
                    <tr>
                      <th scope="row">
                        {bundle.manifest.totals.trialBalanceBalanced ? "The trial balance balances" : "Out by"}
                      </th>
                      <td className="sw-num" colSpan={2}>
                        {bundle.manifest.totals.trialBalanceBalanced ? (
                          <span className="sw-chip sw-chip-ok">balanced</span>
                        ) : (
                          <span className="sw-num-neg">
                            <Figure minor={bundle.manifest.totals.trialBalanceDifferenceMinor} currency={bundle.currency} zero="zero" />
                          </span>
                        )}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </Panel>

            {bundle.warnings.map((w, i) => (
              <div key={i} className="sw-error mb-3" role="alert" data-testid="export-warning">{w}</div>
            ))}

            {failing.length > 0 && (
              <Panel className="mb-3 overflow-hidden">
                <div className="border-b px-3 py-2" style={{ borderColor: "var(--sw-line)", background: "var(--sw-surface-2)" }}>
                  <span className="sw-label">Checks that did not agree</span>
                </div>
                <div className="sw-scroll">
                  <table className="sw-table">
                    <caption className="sr-only">Manifest checks that failed against the exported rows</caption>
                    <thead>
                      <tr>
                        <th>Check</th>
                        <th>Manifest says</th>
                        <th>Rows say</th>
                        <th>What to look at</th>
                      </tr>
                    </thead>
                    <tbody>
                      {failing.map((c) => (
                        <tr key={c.key} data-testid="export-check-failed">
                          <td>{c.label}</td>
                          <td className="sw-code max-w-0 truncate">{c.expected}</td>
                          <td className="sw-code max-w-0 truncate" style={{ color: "var(--sw-neg)" }}>{c.actual}</td>
                          <td className="max-w-0 truncate">{c.note}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Panel>
            )}

            <Panel className="overflow-hidden">
              <div className="border-b px-3 py-2" style={{ borderColor: "var(--sw-line)", background: "var(--sw-surface-2)" }}>
                <span className="sw-label">
                  {bundle.format === "csv" ? "One file per table, plus the manifest" : "One document"}
                </span>
              </div>
              <div className="sw-scroll">
                <table className="sw-table">
                  <caption className="sr-only">Files in this export</caption>
                  <thead>
                    <tr>
                      <th style={{ width: "12rem" }}>File</th>
                      <th>What it carries</th>
                      <th className="sw-num" style={{ width: "6rem" }}>Rows</th>
                      <th style={{ width: "8rem" }}>Save</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bundle.files.map((f) => {
                      const summary = bundle.manifest.tables.find((t) => t.key === f.key);
                      return (
                        <tr key={f.key}>
                          <td className="sw-code">{f.name}</td>
                          <td className="max-w-0 truncate">
                            {summary
                              ? summary.note
                              : f.key === "document"
                                ? `Every table in one document, with the manifest at its head — ${bundle.manifest.tables.length} tables.`
                                : "The manifest: what was exported, its totals, and the digest that proves the rows arrived whole."}
                          </td>
                          <td className="sw-num">
                            {f.rowCount === null ? <span className="sw-zero">–</span> : f.rowCount.toLocaleString("en")}
                          </td>
                          <td>
                            <button
                              type="button"
                              className="sw-btn sw-btn-sm"
                              onClick={() => download(f)}
                              data-testid="download-export-file"
                            >
                              Download
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="sw-sub p-3" style={{ borderTop: "1px solid var(--sw-line)" }}>
                Keep <span className="sw-code">manifest.json</span> with the files. It is what lets anybody — an
                auditor, the next system, you in three years — prove that what they are holding is what left here.
              </p>
            </Panel>
          </>
        )}
      </section>

      {/* ------------------------------------------------------ the import */}

      <section aria-labelledby="import-heading">
        <h2 id="import-heading" className="sw-label mb-2">Bring books in</h2>

        <Panel className="mb-3 p-4">
          <p className="sw-sub max-w-[76ch]">
            Paste the closing trial balance from the system you are leaving and it becomes this system&apos;s
            opening position — a single balanced journal entry, posted through the same path as everything else,
            reversible if the migration was wrong. It is dated the day before the first period you will trade in.
          </p>

          <div className="sw-error mt-3" role="note" data-testid="migration-warning">
            <strong>A trial balance is a position, not a history.</strong> It does not bring the transactions behind
            the balances: the invoices, bills and receipts stay in the old system, and so does every report that
            reads them. It does not bring the open items making up trade receivables and trade payables — those
            arrive as two totals, so nothing is aged and nothing can be matched to a payment until the individual
            open invoices and bills are raised here. It does not bring the fixed-asset register: the net book value
            arrives on the balance sheet, but the assets, their lives and their remaining depreciation do not, so no
            depreciation can be run until the register is loaded. Keep the old system readable for as long as the
            records have to be kept — it is the copy that answers &ldquo;why&rdquo;.
          </div>

          <div className="mt-3">
            <div className="sw-label">Do it in this order</div>
            <ol className="mt-1 max-w-[76ch] list-decimal space-y-1 ps-5">
              <li className="sw-sub">
                <strong>Open the books</strong> — the fiscal year, its periods and the{" "}
                <Link href="/accounting/chart" className="sw-link">chart of accounts</Link> the old balances will
                land on.
              </li>
              <li className="sw-sub">
                <strong>Load the registers</strong> — counterparties with their open invoices and bills, then{" "}
                <Link href="/accounting/assets" className="sw-link">fixed assets</Link>,{" "}
                <Link href="/accounting/leases" className="sw-link">leases</Link> and{" "}
                <Link href="/accounting/inventory" className="sw-link">inventory</Link>.
              </li>
              <li className="sw-sub">
                <strong>Then the trial balance.</strong> In that order the registers reconcile to the control
                accounts on day one. The other way round, this entry posts totals into control accounts that the
                registers then post into a second time, and the books are double-counted before anyone has traded.
              </li>
            </ol>
          </div>
        </Panel>

        <Panel className="mb-3 p-4">
          <div className="flex flex-wrap items-end gap-3">
            <label className="grid gap-1">
              <span className="sw-label">As at</span>
              <input
                type="date"
                className="sw-input"
                style={{ width: "9.5rem" }}
                value={asOf}
                onChange={(e) => { setAsOf(e.target.value); setPlan(null); }}
                aria-label="Balances as at"
              />
            </label>
          </div>
          <label className="mt-3 block">
            <span className="sw-label">Paste the closing trial balance</span>
            <textarea
              className="sw-input mt-1"
              rows={8}
              style={{ fontFamily: "var(--sw-font-mono)", fontSize: "0.75rem" }}
              placeholder={"Code,Account name,Debit,Credit\n1010,Bank,85000.00,\n1100,Trade receivables,42000.00,\n2000,Trade payables,,56000.00\n3000,Share capital,,71000.00"}
              value={text}
              onChange={(e) => { setText(e.target.value); setPlan(null); }}
              data-testid="import-text"
            />
          </label>
          <p className="sw-sub mt-2 max-w-[76ch]">
            Columns are found by name, so most exports work as they come — a debit and credit pair, or one signed
            balance column. Parentheses are read as credits. Accounts this chart does not have are named all at
            once rather than one per attempt, and a trial balance that does not balance is refused with the
            difference stated: a system that posts the gap to a suspense account gives you books that balance and
            are wrong.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <button
              type="button"
              className="sw-btn"
              onClick={check}
              aria-disabled={!text.trim() || busy !== null || undefined}
              disabled={!text.trim() || busy !== null}
              data-testid="import-check"
            >
              {busy === "check" ? "Checking…" : "Check it"}
            </button>
            <span className="sw-sub">Nothing is posted until you say so.</span>
          </div>
        </Panel>

        {importErr && <ErrorNote>{importErr}</ErrorNote>}
        {importMsg && <div className="sw-note mb-3" role="status" data-testid="import-status">{importMsg}</div>}

        {parseProblems.length > 0 && (
          <Panel className="mb-3 p-3">
            <div className="sw-label">Rows that could not be read</div>
            <ul className="mt-1.5 space-y-0.5">
              {parseProblems.map((p, i) => <li key={i} className="sw-sub">{p}</li>)}
            </ul>
            <p className="sw-sub mt-2">
              Listed rather than skipped. A migration that quietly drops rows produces a wrong opening position and
              no warning at all.
            </p>
          </Panel>
        )}

        {plan?.alreadyImported && (
          <div className="sw-note mb-3" role="status" data-testid="import-already">
            An opening position as at {plan.asOf} already exists as{" "}
            <Link href="/accounting/journals" className="sw-link">{plan.reference}</Link>. Bringing it in again
            would double it, so it does nothing. To correct it, reverse that entry and import again.
          </div>
        )}

        {plan && !plan.alreadyImported && plan.blockers.map((b, i) => (
          <div key={i} className="sw-error mb-3" role="alert" data-testid="import-blocker">{b}</div>
        ))}

        {plan && plan.rows.length > 0 && (
          <Panel className="overflow-hidden">
            <div className="border-b px-3 py-2" style={{ borderColor: "var(--sw-line)", background: "var(--sw-surface-2)" }}>
              <span className="sw-label">
                What would be posted — {plan.rows.length} balances as at {plan.asOf}
              </span>
            </div>
            <div className="sw-scroll">
              <table className="sw-table">
                <caption className="sr-only">Trial balance to bring in as at {plan.asOf}</caption>
                <thead>
                  <tr>
                    <th style={{ width: "6rem" }}>Code</th>
                    <th>Account</th>
                    <th className="sw-col-debit sw-num" style={{ width: "var(--sw-col-amount)" }}>Debit</th>
                    <th className="sw-col-credit sw-num" style={{ width: "var(--sw-col-amount)" }}>Credit</th>
                    <th style={{ width: "9rem" }}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.rows.map((r, i) => (
                    <tr key={`${r.accountCode}-${i}`}>
                      <td className="sw-code">{r.accountCode}</td>
                      <td className="max-w-0 truncate">
                        {r.accountName ?? <span className="sw-zero">–</span>}
                        {r.problem && (
                          <span className="block text-[0.6875rem]" style={{ color: "var(--sw-neg)" }}>{r.problem}</span>
                        )}
                      </td>
                      <td className="sw-num">
                        {r.debitMinor !== "0"
                          ? <Figure minor={r.debitMinor} currency={plan.currency} colour={false} />
                          : <span className="sw-zero">–</span>}
                      </td>
                      <td className="sw-num">
                        {r.creditMinor !== "0"
                          ? <Figure minor={r.creditMinor} currency={plan.currency} colour={false} />
                          : <span className="sw-zero">–</span>}
                      </td>
                      <td>
                        {r.problem
                          ? <span className="sw-chip sw-chip-bad">problem</span>
                          : <span className="sw-chip sw-chip-ok">in the chart</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <th scope="row" colSpan={2} style={{ textAlign: "end" }}>Totals</th>
                    <td className="sw-num" data-testid="import-debit">
                      <Figure minor={plan.totalDebitMinor} currency={plan.currency} zero="zero" colour={false} />
                    </td>
                    <td className="sw-num" data-testid="import-credit">
                      <Figure minor={plan.totalCreditMinor} currency={plan.currency} zero="zero" colour={false} />
                    </td>
                    <td>
                      <span className={`sw-chip ${plan.balanced ? "sw-chip-ok" : "sw-chip-bad"}`} data-testid="import-verdict">
                        {plan.balanced ? "balances" : "out of balance"}
                      </span>
                    </td>
                  </tr>
                  {!plan.balanced && (
                    <tr>
                      <th scope="row" colSpan={2} style={{ textAlign: "end", color: "var(--sw-neg)" }}>
                        {BigInt(plan.differenceMinor) > 0n ? "Credits are short by" : "Debits are short by"}
                      </th>
                      <td className="sw-num sw-num-neg" colSpan={3}>
                        <Figure
                          minor={(BigInt(plan.differenceMinor) < 0n
                            ? -BigInt(plan.differenceMinor)
                            : BigInt(plan.differenceMinor)).toString()}
                          currency={plan.currency}
                          zero="zero"
                        />
                      </td>
                    </tr>
                  )}
                </tfoot>
              </table>
            </div>

            <div className="flex flex-wrap items-center gap-3 p-3" style={{ borderTop: "1px solid var(--sw-line)" }}>
              <button
                type="button"
                className="sw-btn sw-btn-primary"
                onClick={runImport}
                aria-disabled={!canImport || busy !== null || undefined}
                disabled={!canImport || busy !== null}
                data-testid="import-run"
              >
                {busy === "import" ? "Bringing them in…" : "Bring these balances in"}
              </button>
              {!canImport && !plan.alreadyImported && (
                <span className="sw-sub" role="status">
                  {plan.blockers[0] ?? "Fix the problems above first."}
                </span>
              )}
            </div>
          </Panel>
        )}
      </section>
    </>
  );
}
