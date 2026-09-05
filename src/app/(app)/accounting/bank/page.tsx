"use client";

import * as React from "react";
import Link from "next/link";
import { api, ApiError, useEntityId, useLedgerQuery } from "@/components/ledger/use-ledger";
import { Figure, PageHead, Panel, ErrorNote, Loading, Empty } from "@/components/ledger/primitives";
import { Attachments } from "@/components/ledger/attachments";
import { useAsk } from "@/components/ledger/ask";
import { fmtMinor, toInput } from "@/lib/ledger/format";

interface Statement {
  accountCode: string; accountName: string; asOf: string; currency: string;
  ledgerBalanceMinor: string; statementBalanceMinor: string | null;
  outstandingInLedgerMinor: string; unrecordedInBankMinor: string;
  reconciledBalanceMinor: string; reconciled: boolean; differenceMinor: string;
  unmatchedBank: { id: string; postedOn: string; description: string; amountMinor: string }[];
  unmatchedLedger: { id: string; reference: string; entryDate: string; memo: string | null; amountMinor: string }[];
  matched: MatchedPair[];
  /**
   * How many items there really are, against the pages of them below.
   *
   * The figures cover the whole life of the account; the lists are the oldest
   * few hundred of each, because an account running for years holds more
   * matched pairs than anyone will read. The counts are what stop a reader
   * adding up the rows on screen and wondering why they miss the total.
   */
  unmatchedBankCount: number;
  unmatchedLedgerCount: number;
  matchedCount: number;
  oldestUnmatchedBankOn: string | null;
  itemsSince: string | null;
  itemLimit: number;
  itemsNote: string;
}
interface MatchedPair {
  bankLineId: string; postedOn: string; description: string; amountMinor: string;
  matchedAt: string | null; journalLineId: string | null; reference: string | null;
  entryDate: string | null; memo: string | null; entryStatus: string | null; reversedBy: string | null;
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
export default function BankPage() {
  const entityId = useEntityId();
  const ask = useAsk();
  const [account] = React.useState("1010");
  const [paste, setPaste] = React.useState("");
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [note, setNote] = React.useState<string | null>(null);
  /**
   * Which statement line's documents are open. One at a time and below the
   * tables rather than expanded inside them: the list read is cheap, but the
   * point of keeping metadata and bytes apart is lost if forty rows each fetch
   * on sight.
   */
  const [docsFor, setDocsFor] = React.useState<{ id: string; description: string } | null>(null);

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

  /**
   * Parsing happens on the server, in the module that knows every format a
   * bank actually hands out — and, more to the point, knows what it cannot
   * read. The version that used to live in this file assumed day-first dates,
   * so a month-first export landed every line in the wrong month without a
   * word; it matched a "Value Date" column as the amount when there was no
   * column called "Amount"; and it read money through a float. None of those
   * announced themselves.
   */
  const doImport = async () => {
    setBusy("import"); setError(null); setNote(null);
    try {
      const parsed = await api<{
        statement: {
          format: string;
          lines: { postedOn: string; description: string; reference?: string; amountMinor: string; balanceMinor?: string }[];
          proof: { provable: boolean; foots: boolean; differenceMinor: string; note: string };
          warnings: string[];
        };
      }>("/api/ledger/bank-import", { method: "POST", body: JSON.stringify({ text: paste }) });

      const st = parsed.statement;
      if (!st.lines.length) { setError("Nothing in that statement could be read as a transaction."); return; }

      // A file whose own lines do not add up to its own closing balance was
      // truncated somewhere between the bank and here. Importing it anyway
      // would put a reconciliation difference into the books that nobody could
      // later explain, so it stops at the door.
      if (st.proof.provable && !st.proof.foots) {
        setError(
          `That statement does not foot: its lines and its own opening and closing balances differ by ` +
            `${toInput(st.proof.differenceMinor.replace("-", "")) || st.proof.differenceMinor}. It has probably been truncated — ` +
            `re-export it, or open it on the import screen where the difference can be seen line by line.`,
        );
        return;
      }

      const r = await act("import", { action: "import", lines: st.lines });
      if (r) {
        setPaste("");
        setNote(
          `Read ${st.lines.length} line${st.lines.length === 1 ? "" : "s"} as ${st.format} and imported ${r.imported}` +
            (Number(r.duplicates) > 0 ? `, skipping ${r.duplicates} already on file` : "") +
            (st.warnings.length ? `. ${st.warnings[0]}` : "."),
        );
      }
    } catch (e) {
      // A refusal here is usually answerable — most often the date order cannot
      // be settled from the file alone — and the import screen is where it can
      // be answered. Sending somebody there beats leaving them at a dead end.
      const why = e instanceof ApiError ? e.message : "That statement could not be read.";
      setError(`${why} The import screen can set the date order and show every parsed row before anything is written down.`);
    } finally {
      setBusy(null);
    }
  };

  /**
   * Undo a match.
   *
   * The arithmetic never depended on it — matching forces equal amounts — so
   * what a wrong match damages is the itemisation: the outstanding-cheque
   * working paper naming the wrong cheque. Until the matched lines were listed
   * there was nothing on the page to correct.
   */
  const doUnmatch = async (m: MatchedPair) => {
    const answer = await ask({
      title: `Unmatch ${m.description}?`,
      detail: m.reversedBy
        ? `This statement line is matched to ${m.reference}, which has been reversed by ${m.reversedBy}. Unmatching ` +
          `puts it back on the list of items to explain. ${m.reversedBy} has a bank line of its own that will stay ` +
          `outstanding until the pair is matched to whichever posting is now correct.`
        : `This statement line is matched to ${m.reference ?? "a posting"}. Unmatching does not touch the posting — it ` +
          `withdraws only the statement that the two are the same event, and both go back on the lists above.`,
      confirmLabel: "Unmatch",
    });
    if (answer === null) return;
    const r = await act(m.bankLineId, { action: "unmatch", bankLineId: m.bankLineId });
    if (r) setNote(`Unmatched ${m.description}. It is back on the list of statement lines to explain.`);
  };

  const toggleDocs = (id: string, description: string) =>
    setDocsFor((d) => (d?.id === id ? null : { id, description }));

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
      {note && <div className="sw-note mb-3" role="status" data-testid="bank-result">{note}</div>}
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
          <p className="sw-sub mt-2 max-w-[80ch]" data-testid="rec-items-note">{st.itemsNote}</p>
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
          style={{ fontFamily: "var(--sw-font-mono)", fontSize: "0.75rem" }}
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
                      <th style={{ width: "6.5rem" }}><span className="sr-only">Documents</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {st.unmatchedBank.map((b) => (
                      <BankRow key={b.id} line={b} busy={busy === b.id}
                        docsOpen={docsFor?.id === b.id}
                        onDocs={() => toggleDocs(b.id, b.description)}
                        onPost={(contra) => act(b.id, { action: "post", bankLineId: b.id, contraAccount: contra })} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <Showing shown={st.unmatchedBank.length} total={st.unmatchedBankCount} what="statement line" />
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
            <Showing shown={st.unmatchedLedger.length} total={st.unmatchedLedgerCount} what="posting" />
            <p className="sw-sub px-3 py-2" style={{ borderTop: "1px solid var(--sw-line)" }}>
              These are cheques written or transfers in flight — real postings the bank has not seen yet.{" "}
              <Link href={`/accounting/accounts/${account}`} className="sw-link">Open the account</Link>.
            </p>
          </Panel>
        </div>
      )}

      {st && (
        <Panel className="mt-4 overflow-hidden">
          <Head>Matched — and how to unpick one</Head>
          {st.matched.length === 0 ? (
            <div className="p-3"><Empty>Nothing has been matched on this account yet.</Empty></div>
          ) : (
            <div className="sw-scroll">
              <table className="sw-table">
                <caption className="sr-only">Statement lines matched to postings, with the match that can be undone</caption>
                <thead>
                  <tr>
                    <th style={{ width: "7rem" }}>Date</th>
                    <th>Statement line</th>
                    <th style={{ width: "8rem" }}>Posting</th>
                    <th>Description</th>
                    <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Amount</th>
                    <th style={{ width: "13rem" }}><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody data-testid="matched-rows">
                  {st.matched.map((m) => (
                    <tr key={m.bankLineId}>
                      <td>{m.postedOn}</td>
                      <td className="max-w-0 truncate">{m.description}</td>
                      <td className="sw-code">
                        {m.reference ?? <span className="sw-zero">–</span>}
                        {m.reversedBy && <span className="sw-chip sw-chip-bad ms-1">reversed</span>}
                      </td>
                      <td className="max-w-0 truncate">
                        {m.reversedBy ? (
                          // The one case where a matched line is not a settled
                          // one: the posting behind it has been undone, and the
                          // reversal's own bank line is sitting in "in our
                          // books, not on the statement" where it will never
                          // clear, because the bank saw neither half.
                          <span style={{ color: "var(--sw-neg)" }}>
                            {m.reference} was reversed by {m.reversedBy}. Unmatch this line and match it to the
                            posting that is now right, or the reversal stays outstanding for good.
                          </span>
                        ) : (
                          m.memo ?? <span className="sw-zero">–</span>
                        )}
                      </td>
                      <td className="sw-num"><Figure minor={m.amountMinor} /></td>
                      <td>
                        <span className="flex flex-wrap items-center gap-1 py-1">
                          <button
                            type="button"
                            className="sw-btn sw-btn-sm"
                            disabled={busy === m.bankLineId}
                            aria-disabled={busy === m.bankLineId || undefined}
                            onClick={() => doUnmatch(m)}
                          >
                            <span aria-hidden="true">{busy === m.bankLineId ? "…" : "Unmatch"}</span>
                            <span className="sr-only">{`Unmatch ${m.description}`}</span>
                          </button>
                          <button
                            type="button"
                            className="sw-btn sw-btn-sm"
                            aria-expanded={docsFor?.id === m.bankLineId}
                            onClick={() => toggleDocs(m.bankLineId, m.description)}
                          >
                            <span aria-hidden="true">Documents</span>
                            <span className="sr-only">{`Documents for ${m.description}`}</span>
                          </button>
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <Showing shown={st.matched.length} total={st.matchedCount} what="matched pair" />
          <p className="sw-sub px-3 py-2" style={{ borderTop: "1px solid var(--sw-line)" }}>
            A match is a statement that two records describe the same event, and unmatching withdraws only that —
            the posting stays exactly as it was. Booking a line to the wrong account is a different mistake:
            unmatch it, reverse the entry from the{" "}
            <Link href="/accounting/journals" className="sw-link">journal register</Link>, then post the correction
            as a journal and match this line to it. The same line cannot be booked from here twice, because the
            second attempt would hand back the first entry rather than a new one.
          </p>
        </Panel>
      )}

      {docsFor && (
        <Panel className="mt-4 overflow-hidden">
          <Head>Documents — {docsFor.description}</Head>
          <Attachments
            subjectType="BANK_LINE"
            subjectId={docsFor.id}
            entityId={entityId}
            title={`Attached to the statement line of ${docsFor.description}`}
            note="The bank's advice or letter behind this line. A charge nobody can explain a year later is explained by the document that came with it, not by the memo somebody typed."
          />
        </Panel>
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

function BankRow({ line, busy, docsOpen, onDocs, onPost }: {
  line: { id: string; postedOn: string; description: string; amountMinor: string };
  busy: boolean;
  docsOpen: boolean;
  onDocs: () => void;
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
      <td>
        <button
          type="button"
          className="sw-btn sw-btn-sm"
          aria-expanded={docsOpen}
          onClick={onDocs}
        >
          <span aria-hidden="true">Documents</span>
          <span className="sr-only">{`Documents for ${line.description}`}</span>
        </button>
      </td>
    </tr>
  );
}

/**
 * What a list leaves out.
 *
 * Silence here would be the wrong answer twice over: a reader who counts the
 * rows would get a number the reconciliation above contradicts, and the oldest
 * uncleared item — the one worth chasing — would look as though it did not
 * exist. Nothing is said when the list is the whole of it.
 */
function Showing({ shown, total, what }: { shown: number; total: number; what: string }) {
  if (shown >= total) return null;
  return (
    <p className="sw-sub px-3 py-2" style={{ borderTop: "1px solid var(--sw-line)" }} data-testid={`showing-${what.replace(/\s+/g, "-")}`}>
      Showing the oldest {shown} of {total} {what}s. The figures above cover all {total}.
    </p>
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
