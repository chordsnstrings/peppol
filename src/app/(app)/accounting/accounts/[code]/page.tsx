"use client";

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEntityId, useLedgerQuery } from "@/components/ledger/use-ledger";
import { Figure, PageHead, Panel, ErrorNote, Loading, Empty } from "@/components/ledger/primitives";

interface GLLine {
  entryId: string; reference: string; date: string; memo: string | null;
  source: string; sourceType: string | null; sourceId: string | null; status: string;
  debitMinor: string; creditMinor: string; runningMinor: string;
}
interface GL {
  account: { code: string; name: string; nameAr: string | null; type: string };
  /** The account's balance going into the range; nought when no range was asked for. */
  openingMinor: string;
  /** What the first listed line opens from — the opening balance plus anything the page did not reach. */
  broughtForwardMinor: string;
  /** Aggregated over the whole account, not totalled from the lines below it. */
  closingMinor: string;
  lineCount: number;
  listed: number;
  truncated: boolean;
  lines: GLLine[];
}

export default function AccountDetail() {
  const code = decodeURIComponent(String(useParams().code ?? ""));
  const entityId = useEntityId();
  const [from, setFrom] = React.useState("");
  const [to, setTo] = React.useState("");

  const qs = new URLSearchParams({ entityId: entityId ?? "" });
  if (from) qs.set("from", from);
  if (to) qs.set("to", to);
  const { data, error, loading } = useLedgerQuery<GL>(
    entityId ? `/api/ledger/accounts/${encodeURIComponent(code)}?${qs}` : null,
  );

  if (!entityId) return <Loading label="Choosing an entity…" />;

  const lines = data?.lines ?? [];
  const notListed = data ? data.lineCount - data.listed : 0;
  /* The brought-forward row is what makes the column add up: without it the
   * first figure in the balance column is a movement pretending to be a
   * balance. It earns its place whenever something precedes the first listed
   * line — a range that starts after the account did, or a page that starts
   * after the range did. */
  const showBroughtForward = Boolean(data && (from || data.truncated));

  return (
    <>
      <PageHead
        title={data ? `${data.account.code} — ${data.account.name}` : code}
        sub={
          data
            ? `${data.account.type.toLowerCase()} account. Every line traces back to the journal that produced it, and from there to the document that produced the journal.`
            : undefined
        }
        actions={
          <>
            <label className="flex items-center gap-1.5">
              <span className="sw-label">From</span>
              <input type="date" className="sw-input" style={{ width: "9.5rem" }} value={from} onChange={(e) => setFrom(e.target.value)} />
            </label>
            <label className="flex items-center gap-1.5">
              <span className="sw-label">To</span>
              <input type="date" className="sw-input" style={{ width: "9.5rem" }} value={to} onChange={(e) => setTo(e.target.value)} />
            </label>
          </>
        }
      />

      <p className="mb-3">
        <Link href="/accounting/accounts" className="sw-link text-[0.8125rem]">← Chart of accounts</Link>
      </p>

      {error && <ErrorNote>{error}</ErrorNote>}
      {loading && <Loading />}
      {!loading && !error && lines.length === 0 && (
        <Empty>
          Nothing has been posted to {code}{from || to ? " in this date range" : ""}.
          {data && from && BigInt(data.openingMinor) !== 0n && (
            <> It carried a balance of <Figure minor={data.openingMinor} /> into it.</>
          )}
        </Empty>
      )}

      {data && data.truncated && lines.length > 0 && (
        <p className="sw-sub mb-3 max-w-[75ch]" role="status" data-testid="gl-truncated">
          The most recent {data.listed} of {data.lineCount} lines are listed. The balance brought forward at the top
          of the table already holds the {notListed} earlier {notListed === 1 ? "line" : "lines"} that are not, and
          the closing balance is the whole account&rsquo;s — neither figure is a total of this page.
        </p>
      )}

      {lines.length > 0 && data && (
        <Panel className="overflow-hidden">
          <div className="sw-scroll">
            <table className="sw-table">
              <caption className="sr-only">General ledger detail for account {data.account.code}</caption>
              <thead>
                <tr>
                  <th style={{ width: "7rem" }}>Date</th>
                  <th style={{ width: "8rem" }}>Reference</th>
                  <th>Description</th>
                  <th className="hidden md:table-cell" style={{ width: "7rem" }}>Source</th>
                  <th className="sw-col-debit sw-num" style={{ width: "var(--sw-col-amount)" }}>Debit</th>
                  <th className="sw-col-credit sw-num" style={{ width: "var(--sw-col-amount)" }}>Credit</th>
                  <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Balance</th>
                </tr>
              </thead>
              <tbody>
                {showBroughtForward && (
                  <tr data-testid="gl-brought-forward">
                    <td>{from}</td>
                    <td />
                    {/* Not truncated like the memo cells around it: the clause
                        that says what this figure includes is the whole reason
                        the row can be read as a fact rather than a guess. */}
                    <td>
                      Balance brought forward
                      {data.truncated && ` — including ${notListed} earlier ${notListed === 1 ? "line" : "lines"} not listed`}
                    </td>
                    <td className="hidden md:table-cell" />
                    <td className="sw-num"><span className="sw-zero">–</span></td>
                    <td className="sw-num"><span className="sw-zero">–</span></td>
                    <td className="sw-num"><Figure minor={data.broughtForwardMinor} zero="zero" /></td>
                  </tr>
                )}
                {lines.map((l, i) => (
                  <tr key={`${l.entryId}-${i}`}>
                    <td>{l.date.slice(0, 10)}</td>
                    <td className="sw-code">
                      {l.reference}
                      {l.status === "reversed" && <span className="sw-chip sw-chip-warn ms-1">reversed</span>}
                    </td>
                    <td className="max-w-0 truncate">{l.memo ?? <span className="sw-zero">–</span>}</td>
                    <td className="hidden md:table-cell" style={{ color: "var(--sw-fg-muted)" }}>{l.sourceType ?? l.source}</td>
                    <td className="sw-num">
                      {BigInt(l.debitMinor) !== 0n ? <Figure minor={l.debitMinor} colour={false} /> : <span className="sw-zero">–</span>}
                    </td>
                    <td className="sw-num">
                      {BigInt(l.creditMinor) !== 0n ? <Figure minor={l.creditMinor} colour={false} /> : <span className="sw-zero">–</span>}
                    </td>
                    <td className="sw-num"><Figure minor={l.runningMinor} zero="zero" /></td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row" colSpan={6} style={{ textAlign: "end" }}>Closing balance</th>
                  <td className="sw-num" data-testid="gl-closing"><Figure minor={data.closingMinor} zero="zero" /></td>
                </tr>
              </tfoot>
            </table>
          </div>
        </Panel>
      )}
    </>
  );
}
