"use client";

import * as React from "react";
import Link from "next/link";
import { api, ApiError, useEntityId, useLedgerQuery } from "@/components/ledger/use-ledger";
import { Figure, PageHead, Panel, ErrorNote, Loading, Empty } from "@/components/ledger/primitives";
import { fmtMinor, parseAmount } from "@/lib/ledger/format";

interface Statement {
  accountCode: string; accountName: string; asOf: string; currency: string;
  ledgerBalanceMinor: string; statementBalanceMinor: string | null;
  outstandingInLedgerMinor: string; unrecordedInBankMinor: string;
  reconciledBalanceMinor: string; reconciled: boolean; differenceMinor: string;
  unmatchedBank: { id: string; postedOn: string; description: string; amountMinor: string }[];
  unmatchedLedger: { id: string; reference: string; entryDate: string; memo: string | null; amountMinor: string }[];
}
interface Suggestion {
  bankLineId: string; journalLineId: string; entryReference: string; entryMemo: string | null;
  entryDate: string; amountMinor: string; dayGap: number; confidence: number; why: string[];
}

/**
 * Parse a pasted bank statement.
 *
 * Every bank exports something slightly different, so rather than demanding one
 * layout this reads the header row and finds the columns by name. What it
 * cannot identify it reports, instead of importing a column of zeroes.
 */
function parseStatement(text: string): { lines: { postedOn: string; description: string; reference?: string; amountMinor: string; balanceMinor?: string }[]; problems: string[] } {
  const rows = text.trim().split(/\r?\n/).filter((r) => r.trim());
  if (rows.length < 2) return { lines: [], problems: ["Paste the header row and at least one transaction."] };

  const split = (r: string) => (r.includes("\t") ? r.split("\t") : r.split(",")).map((c) => c.trim().replace(/^"|"$/g, ""));
  const header = split(rows[0]).map((h) => h.toLowerCase());
  const find = (...names: string[]) => header.findIndex((h) => names.some((n) => h.includes(n)));

  const iDate = find("date", "posted", "value");
  const iDesc = find("description", "narrative", "details", "particulars", "remarks");
  const iAmount = find("amount", "value");
  const iDebit = find("debit", "withdraw", "paid out");
  const iCredit = find("credit", "deposit", "paid in");
  const iRef = find("reference", "ref", "cheque");
  const iBalance = find("balance");

  const problems: string[] = [];
  if (iDate < 0) problems.push("No date column — the header needs one containing “date”.");
  if (iDesc < 0) problems.push("No description column — the header needs one containing “description” or “narrative”.");
  if (iAmount < 0 && (iDebit < 0 || iCredit < 0)) {
    problems.push("No amount column, and no debit/credit pair either.");
  }
  if (problems.length) return { lines: [], problems };

  const lines: { postedOn: string; description: string; reference?: string; amountMinor: string; balanceMinor?: string }[] = [];
  rows.slice(1).forEach((r, i) => {
    const c = split(r);
    const raw = c[iDate] ?? "";
    // Accept ISO, and dd/mm/yyyy which is what UAE banks export.
    const iso = /^\d{4}-\d{2}-\d{2}/.test(raw)
      ? raw.slice(0, 10)
      : (() => {
          const m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/.exec(raw);
          if (!m) return null;
          const y = m[3].length === 2 ? `20${m[3]}` : m[3];
          return `${y}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
        })();
    if (!iso) { problems.push(`Row ${i + 2}: could not read the date "${raw}".`); return; }

    let amount: bigint | null;
    if (iAmount >= 0) {
      amount = parseAmount(c[iAmount] ?? "");
    } else {
      const dr = parseAmount(c[iDebit] ?? "") ?? 0n;
      const cr = parseAmount(c[iCredit] ?? "") ?? 0n;
      // A debit column on a bank statement is money leaving the account.
      amount = cr - dr;
    }
    if (amount === null) { problems.push(`Row ${i + 2}: could not read the amount.`); return; }
    if (amount === 0n) return; // nothing to reconcile

    const bal = iBalance >= 0 ? parseAmount(c[iBalance] ?? "") : null;
    lines.push({
      postedOn: iso,
      description: c[iDesc] ?? "",
      reference: iRef >= 0 ? c[iRef] || undefined : undefined,
      amountMinor: amount.toString(),
      balanceMinor: bal === null ? undefined : bal.toString(),
    });
  });

  return { lines, problems };
}

export default function BankPage() {
  const entityId = useEntityId();
  const [account] = React.useState("1010");
  const [paste, setPaste] = React.useState("");
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [note, setNote] = React.useState<string | null>(null);

  const q = useLedgerQuery<{ statement: Statement; suggestions: Suggestion[] }>(
    entityId ? `/api/ledger/bank?entityId=${entityId}&account=${account}` : null,
  );

  const act = async (label: string, body: Record<string, unknown>) => {
    setBusy(label); setError(null); setNote(null);
    try {
      const r = await api<Record<string, unknown>>("/api/ledger/bank", {
        method: "POST", body: JSON.stringify({ entityId, account, ...body }),
      });
      q.reload();
      return r;
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "That did not work.");
      return null;
    } finally {
      setBusy(null);
    }
  };

  const doImport = async () => {
    const { lines, problems } = parseStatement(paste);
    if (problems.length && lines.length === 0) { setError(problems.join(" ")); return; }
    const r = await act("import", { action: "import", lines });
    if (r) {
      setPaste("");
      setNote(
        `Imported ${r.imported} line${r.imported === 1 ? "" : "s"}` +
          (Number(r.duplicates) > 0 ? `, skipping ${r.duplicates} already on file` : "") +
          (problems.length ? `. ${problems.length} row${problems.length === 1 ? "" : "s"} could not be read: ${problems[0]}` : "."),
      );
    }
  };

  if (!entityId) return <Loading label="Choosing an entity…" />;
  const st = q.data?.statement;
  const sug = q.data?.suggestions ?? [];

  return (
    <>
      <PageHead
        title="Bank reconciliation"
        sub="The bank's record and ours, side by side. They are kept apart on purpose — comparing two independent accounts of the same events is what catches a payment recorded twice or a charge nobody booked."
      />

      {error && <ErrorNote>{error}</ErrorNote>}
      {note && <div className="sw-note mb-3" role="status">{note}</div>}
      {q.error && <ErrorNote>{q.error}</ErrorNote>}
      {q.loading && !st && <Loading />}

      {st && (
        <Panel className="mb-4 p-4">
          <div className="sw-label">Reconciliation — {st.accountCode} {st.accountName} as at {st.asOf}</div>
          <table className="sw-table mt-3" style={{ maxWidth: "40rem" }}>
            <caption className="sr-only">Our balance reconciled to the bank statement</caption>
            <tbody>
              <Row label="Balance per our ledger" minor={st.ledgerBalanceMinor} currency={st.currency} />
              <Row label="Less: posted but not yet on the statement" minor={`-${st.outstandingInLedgerMinor}`} currency={st.currency} />
              <Row label="Add: on the statement but not yet posted" minor={st.unrecordedInBankMinor} currency={st.currency} />
              <tr>
                <th scope="row" style={{ textAlign: "start", borderTop: "1px solid var(--sw-line-strong)" }}>Reconciled balance</th>
                <td className="sw-num" style={{ fontWeight: 600, borderTop: "1px solid var(--sw-line-strong)" }} data-testid="rec-balance">
                  <Figure minor={st.reconciledBalanceMinor} currency={st.currency} zero="zero" />
                </td>
              </tr>
              <Row label="Balance per the bank statement" minor={st.statementBalanceMinor ?? "0"} currency={st.currency} />
            </tbody>
          </table>
          <p className="sw-sub mt-3" data-testid="rec-verdict">
            {st.statementBalanceMinor === null
              ? "The imported file carried no running balance, so there is nothing to reconcile against yet. Import a statement that includes a balance column."
              : st.reconciled
                ? "Reconciled. Every difference between the two records is explained by the items below."
                : `Out by ${fmtMinor(st.differenceMinor, st.currency, { zero: "zero" })} — something is on one record and not the other, and not accounted for below.`}
          </p>
        </Panel>
      )}

      <Panel className="mb-4 p-4">
        <div className="sw-label">Import a statement</div>
        <p className="sw-sub mt-1 max-w-[70ch]">
          Paste it straight from the bank&apos;s export, header row included. Columns are found by name, so
          most layouts work as they come. Re-importing an overlapping period is safe — lines already on file
          are skipped rather than duplicated.
        </p>
        <textarea
          className="sw-input mt-2"
          rows={5}
          style={{ fontFamily: "ui-monospace, monospace", fontSize: "0.75rem" }}
          placeholder={"Date,Description,Reference,Amount,Balance\n01/06/2026,Customer receipt,FT001,2500.00,2500.00"}
          value={paste}
          onChange={(e) => setPaste(e.target.value)}
          aria-label="Bank statement to import"
        />
        <button
          type="button"
          className="sw-btn sw-btn-primary mt-2"
          onClick={doImport}
          aria-disabled={!paste.trim() || busy === "import" || undefined}
          disabled={!paste.trim() || busy === "import"}
          data-testid="import-statement"
        >
          {busy === "import" ? "Importing…" : "Import"}
        </button>
      </Panel>

      {sug.length > 0 && (
        <Panel className="mb-4 overflow-hidden">
          <Head>Suggested matches</Head>
          <p className="sw-sub px-3 pt-2">
            These are proposals, not decisions. The value of a reconciliation is that a person looked, so
            nothing here is applied until you say so.
          </p>
          <div className="sw-scroll">
            <table className="sw-table">
              <caption className="sr-only">Proposed matches between bank lines and our postings</caption>
              <thead>
                <tr>
                  <th>Bank line</th>
                  <th>Our posting</th>
                  <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Amount</th>
                  <th style={{ width: "7rem" }}>Confidence</th>
                  <th style={{ width: "6rem" }}><span className="sr-only">Action</span></th>
                </tr>
              </thead>
              <tbody>
                {sug.map((s) => {
                  const bankLine = st?.unmatchedBank.find((b) => b.id === s.bankLineId);
                  return (
                    <tr key={s.bankLineId}>
                      <td className="max-w-0 truncate">
                        {bankLine?.postedOn} · {bankLine?.description}
                      </td>
                      <td className="max-w-0 truncate">
                        <span className="sw-code">{s.entryReference}</span> {s.entryMemo}
                        <span className="block text-[0.6875rem]" style={{ color: "var(--sw-fg-muted)" }}>
                          {s.why.join("; ")}
                        </span>
                      </td>
                      <td className="sw-num"><Figure minor={s.amountMinor} /></td>
                      <td>
                        <span className={`sw-chip ${s.confidence >= 70 ? "sw-chip-ok" : "sw-chip-warn"}`}>
                          {s.confidence}%
                        </span>
                      </td>
                      <td>
                        <button
                          type="button"
                          className="sw-btn sw-btn-sm"
                          disabled={busy === s.bankLineId}
                          onClick={() => act(s.bankLineId, { action: "match", bankLineId: s.bankLineId, journalLineId: s.journalLineId })}
                        >
                          {busy === s.bankLineId ? "…" : "Match"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      {st && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Panel className="overflow-hidden">
            <Head>On the statement, not in our books</Head>
            {st.unmatchedBank.length === 0 ? (
              <div className="p-3"><Empty>Nothing. Every line the bank reported is accounted for.</Empty></div>
            ) : (
              <div className="sw-scroll">
                <table className="sw-table">
                  <caption className="sr-only">Statement lines with no posting behind them</caption>
                  <thead>
                    <tr>
                      <th style={{ width: "7rem" }}>Date</th>
                      <th>Description</th>
                      <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Amount</th>
                      <th style={{ width: "10rem" }}><span className="sr-only">Post</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {st.unmatchedBank.map((b) => (
                      <BankRow key={b.id} line={b} busy={busy === b.id}
                        onPost={(contra) => act(b.id, { action: "post", bankLineId: b.id, contraAccount: contra })} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          <Panel className="overflow-hidden">
            <Head>In our books, not on the statement</Head>
            {st.unmatchedLedger.length === 0 ? (
              <div className="p-3"><Empty>Nothing. Every posting has cleared the bank.</Empty></div>
            ) : (
              <div className="sw-scroll">
                <table className="sw-table">
                  <caption className="sr-only">Postings the bank has not seen yet</caption>
                  <thead>
                    <tr>
                      <th style={{ width: "7rem" }}>Date</th>
                      <th style={{ width: "8rem" }}>Reference</th>
                      <th>Description</th>
                      <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {st.unmatchedLedger.map((l) => (
                      <tr key={l.id}>
                        <td>{l.entryDate}</td>
                        <td className="sw-code">{l.reference}</td>
                        <td className="max-w-0 truncate">{l.memo ?? <span className="sw-zero">–</span>}</td>
                        <td className="sw-num"><Figure minor={l.amountMinor} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="sw-sub px-3 py-2" style={{ borderTop: "1px solid var(--sw-line)" }}>
              These are cheques written or transfers in flight — real postings the bank has not seen yet.{" "}
              <Link href={`/accounting/accounts/${account}`} className="sw-link">Open the account</Link>.
            </p>
          </Panel>
        </div>
      )}
    </>
  );
}

/** The contra account for an unexplained bank line — the one decision that matters. */
const CONTRAS = [
  { code: "6350", label: "Bank charges" },
  { code: "4900", label: "Other income" },
  { code: "6900", label: "Other operating expenses" },
  { code: "3100", label: "Shareholder current account" },
  { code: "6100", label: "Rent" },
];

function BankRow({ line, busy, onPost }: {
  line: { id: string; postedOn: string; description: string; amountMinor: string };
  busy: boolean;
  onPost: (contra: string) => void;
}) {
  const [contra, setContra] = React.useState("");
  return (
    <tr>
      <td>{line.postedOn}</td>
      <td className="max-w-0 truncate">{line.description}</td>
      <td className="sw-num"><Figure minor={line.amountMinor} /></td>
      <td>
        <span className="flex items-center gap-1 py-1">
          <label className="sr-only" htmlFor={`contra-${line.id}`}>Account for {line.description}</label>
          <select
            id={`contra-${line.id}`}
            className="sw-select sw-select-sm"
            value={contra}
            onChange={(e) => setContra(e.target.value)}
          >
            <option value="">Book as…</option>
            {CONTRAS.map((c) => <option key={c.code} value={c.code}>{c.code} {c.label}</option>)}
          </select>
          <button
            type="button"
            className="sw-btn sw-btn-sm"
            aria-disabled={!contra || busy || undefined}
            disabled={!contra || busy}
            onClick={() => onPost(contra)}
          >
            {busy ? "…" : "Post"}
          </button>
        </span>
      </td>
    </tr>
  );
}

function Head({ children }: { children: React.ReactNode }) {
  return (
    <div className="border-b px-3 py-2" style={{ borderColor: "var(--sw-line)", background: "var(--sw-surface-2)" }}>
      <span className="sw-label">{children}</span>
    </div>
  );
}

function Row({ label, minor, currency }: { label: string; minor: string; currency: string }) {
  return (
    <tr>
      <th scope="row" style={{ textAlign: "start", fontWeight: 400 }}>{label}</th>
      <td className="sw-num" style={{ width: "var(--sw-col-amount)" }}>
        <Figure minor={minor} currency={currency} zero="zero" />
      </td>
    </tr>
  );
}
