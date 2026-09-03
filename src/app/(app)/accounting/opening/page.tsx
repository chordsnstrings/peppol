"use client";

import * as React from "react";
import Link from "next/link";
import { api, ApiError, useEntityId } from "@/components/ledger/use-ledger";
import { Figure, PageHead, Panel, ErrorNote, Loading } from "@/components/ledger/primitives";

interface Line {
  accountCode: string; accountName: string | null;
  debitMinor: string; creditMinor: string;
  exists: boolean; postable: boolean; problem: string | null;
}
interface Preview {
  asOf: string; currency: string; lines: Line[];
  totalDebitMinor: string; totalCreditMinor: string; differenceMinor: string;
  balanced: boolean; blockers: string[]; alreadyImported: boolean; reference: string | null;
}

/**
 * Bringing an existing business onto the ledger.
 *
 * The shape of this screen is deliberate: paste, look at what will happen, then
 * post. A migration is the one thing a customer cannot undo in their own mind,
 * so every problem is shown at once rather than one per attempt.
 */
export default function OpeningBalancesPage() {
  const entityId = useEntityId();
  const [asOf, setAsOf] = React.useState(() => `${new Date().getUTCFullYear()}-01-01`);
  const [text, setText] = React.useState("");
  const [preview, setPreview] = React.useState<Preview | null>(null);
  const [parseProblems, setParseProblems] = React.useState<string[]>([]);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [done, setDone] = React.useState<string | null>(null);

  const call = async <T,>(body: Record<string, unknown>): Promise<T | null> => {
    setErr(null);
    try {
      return await api<T>("/api/ledger/opening", { method: "POST", body: JSON.stringify({ entityId, ...body }) });
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "That did not work.");
      return null;
    }
  };

  const check = async () => {
    setBusy("check"); setDone(null);
    const parsed = await call<{ lines: unknown[]; problems: string[] }>({ action: "parse", text });
    if (!parsed) { setBusy(null); return; }
    setParseProblems(parsed.problems);
    if (parsed.lines.length === 0) { setPreview(null); setBusy(null); return; }
    const p = await call<Preview>({ action: "preview", asOf, lines: parsed.lines });
    setPreview(p);
    setBusy(null);
  };

  const doImport = async () => {
    if (!preview) return;
    setBusy("import"); setDone(null);
    const parsed = await call<{ lines: unknown[] }>({ action: "parse", text });
    if (!parsed) { setBusy(null); return; }
    const r = await call<{ reference: string; linesPosted: number; accountsCreated: number; alreadyImported: boolean }>({
      action: "import", asOf, lines: parsed.lines,
    });
    if (r) {
      setDone(
        r.alreadyImported
          ? `Balances for ${asOf} were already imported as ${r.reference}.`
          : `Imported ${r.linesPosted} balances as ${r.reference}` +
            (r.accountsCreated ? `, creating ${r.accountsCreated} account${r.accountsCreated === 1 ? "" : "s"}` : "") + ".",
      );
      const p = await call<Preview>({ action: "preview", asOf, lines: parsed.lines });
      setPreview(p);
    }
    setBusy(null);
  };

  if (!entityId) return <Loading label="Choosing an entity…" />;
  const canImport = preview && preview.balanced && preview.blockers.length === 0 && !preview.alreadyImported;

  return (
    <>
      <PageHead
        title="Opening balances"
        sub="Carry an existing trial balance onto the ledger. It posts as an ordinary journal entry, so the same rules apply to it as to everything else and it can be reversed if the migration was wrong."
        actions={
          <label className="flex items-center gap-1.5">
            <span className="sw-label">As at</span>
            <input
              type="date"
              className="sw-input"
              style={{ width: "9.5rem" }}
              value={asOf}
              onChange={(e) => { setAsOf(e.target.value); setPreview(null); }}
              aria-label="Balances as at"
            />
          </label>
        }
      />

      {err && <ErrorNote>{err}</ErrorNote>}
      {done && <div className="sw-note mb-3" role="status" data-testid="opening-done">{done}</div>}

      <Panel className="mb-4 p-4">
        <div className="sw-label">Paste your trial balance</div>
        <p className="sw-sub mt-1 max-w-[72ch]">
          Straight from your accountant&apos;s export, header row included. Columns are found by name, so most
          layouts work as they come — a debit and credit pair, or one signed balance column. Parentheses are read
          as credits.
        </p>
        <textarea
          className="sw-input mt-2"
          rows={8}
          style={{ fontFamily: "ui-monospace, monospace", fontSize: "0.75rem" }}
          placeholder={"Code,Account name,Debit,Credit\n1010,Bank,85000.00,\n1100,Trade receivables,42000.00,\n2000,Trade payables,,56000.00\n3000,Share capital,,71000.00"}
          value={text}
          onChange={(e) => { setText(e.target.value); setPreview(null); }}
          aria-label="Trial balance to import"
        />
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <button
            type="button"
            className="sw-btn"
            onClick={check}
            aria-disabled={!text.trim() || busy !== null || undefined}
            disabled={!text.trim() || busy !== null}
            data-testid="opening-check"
          >
            {busy === "check" ? "Checking…" : "Check it"}
          </button>
          <span className="sw-sub">Nothing is posted until you say so.</span>
        </div>
      </Panel>

      {parseProblems.length > 0 && (
        <Panel className="mb-4 p-3">
          <div className="sw-label">Rows that could not be read</div>
          <ul className="mt-1.5 space-y-0.5">
            {parseProblems.map((p, i) => <li key={i} className="sw-sub">{p}</li>)}
          </ul>
          <p className="sw-sub mt-2">
            These are listed rather than skipped. A migration that quietly drops rows produces a wrong opening
            position and no warning.
          </p>
        </Panel>
      )}

      {preview?.alreadyImported && (
        <div className="sw-note mb-4" data-testid="already-imported">
          Balances as at {preview.asOf} have already been imported as{" "}
          <Link href="/accounting/journals" className="sw-link">{preview.reference}</Link>. Importing again would
          double them, so it does nothing. To correct them, reverse that entry and import again.
        </div>
      )}

      {preview && !preview.alreadyImported && preview.blockers.map((b, i) => (
        <div key={i} className="sw-error mb-3" role="alert" data-testid="opening-blocker">{b}</div>
      ))}

      {preview && preview.lines.length > 0 && (
        <Panel className="overflow-hidden">
          <div className="border-b px-3 py-2" style={{ borderColor: "var(--sw-line)", background: "var(--sw-surface-2)" }}>
            <span className="sw-label">What would be posted — {preview.lines.length} balances as at {preview.asOf}</span>
          </div>
          <div className="sw-scroll">
            <table className="sw-table">
              <caption className="sr-only">Opening balances to import as at {preview.asOf}</caption>
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
                {preview.lines.map((l, i) => (
                  <tr key={`${l.accountCode}-${i}`}>
                    <td className="sw-code">{l.accountCode}</td>
                    <td className="max-w-0 truncate">
                      {l.accountName ?? <span className="sw-zero">–</span>}
                      {l.problem && (
                        <span className="block text-[0.6875rem]" style={{ color: "var(--sw-neg)" }}>{l.problem}</span>
                      )}
                    </td>
                    <td className="sw-num">
                      {l.debitMinor !== "0" ? <Figure minor={l.debitMinor} currency={preview.currency} colour={false} /> : <span className="sw-zero">–</span>}
                    </td>
                    <td className="sw-num">
                      {l.creditMinor !== "0" ? <Figure minor={l.creditMinor} currency={preview.currency} colour={false} /> : <span className="sw-zero">–</span>}
                    </td>
                    <td>
                      {l.problem
                        ? <span className="sw-chip sw-chip-bad">problem</span>
                        : l.exists
                          ? <span className="sw-chip sw-chip-ok">in the chart</span>
                          : <span className="sw-chip sw-chip-accent">will be created</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row" colSpan={2} style={{ textAlign: "end" }}>Totals</th>
                  <td className="sw-num" data-testid="opening-debit">
                    <Figure minor={preview.totalDebitMinor} currency={preview.currency} zero="zero" colour={false} />
                  </td>
                  <td className="sw-num" data-testid="opening-credit">
                    <Figure minor={preview.totalCreditMinor} currency={preview.currency} zero="zero" colour={false} />
                  </td>
                  <td>
                    <span className={`sw-chip ${preview.balanced ? "sw-chip-ok" : "sw-chip-bad"}`} data-testid="opening-verdict">
                      {preview.balanced ? "balances" : "out of balance"}
                    </span>
                  </td>
                </tr>
                {!preview.balanced && (
                  <tr>
                    <th scope="row" colSpan={2} style={{ textAlign: "end", color: "var(--sw-neg)" }}>
                      {BigInt(preview.differenceMinor) > 0n ? "Credits are short by" : "Debits are short by"}
                    </th>
                    <td className="sw-num sw-num-neg" colSpan={3}>
                      <Figure
                        minor={(BigInt(preview.differenceMinor) < 0n ? -BigInt(preview.differenceMinor) : BigInt(preview.differenceMinor)).toString()}
                        currency={preview.currency}
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
              onClick={doImport}
              aria-disabled={!canImport || busy !== null || undefined}
              disabled={!canImport || busy !== null}
              data-testid="opening-import"
            >
              {busy === "import" ? "Importing…" : "Import these balances"}
            </button>
            {!canImport && !preview.alreadyImported && (
              <span className="sw-sub" role="status">
                {preview.blockers[0] ?? "Fix the problems above first."}
              </span>
            )}
          </div>
        </Panel>
      )}
    </>
  );
}
