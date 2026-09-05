"use client";

import * as React from "react";
import Link from "next/link";
import { useAppState } from "@/lib/app-state";
import { useInvoices } from "@/hooks/use-entity-data";
import { useLedgerQuery } from "@/components/ledger/use-ledger";
import { Figure, PageHead, Panel, ErrorNote, Loading, Empty } from "@/components/ledger/primitives";
import { CustomerReceipt } from "@/components/ledger/ar-receipt";
import {
  AR_CONTROL,
  isPostable,
  ledgerProblem,
  postInvoiceToLedger,
  useSalesLedger,
} from "@/components/ledger/ar-posting";
import { fmtMinor } from "@/lib/ledger/format";
import type { Invoice } from "@/lib/domain/types";

/**
 * Receivables — what is owed to us, and the two things that put it there.
 *
 * The sales subledger has been able to post an invoice and a customer receipt
 * since it was written, and nothing in the browser called either: the whole
 * report below was fed by an empty set, and its old empty state — "every
 * invoice raised has been settled" — was the sentence an untouched ledger also
 * produces. Two opposite facts, one sentence. So this screen carries the
 * working loop the ageing depends on rather than only reporting on a ledger
 * somebody else was expected to fill.
 *
 * It is the mirror of the payables screen, deliberately and down to the shape
 * of its two lists: the ageing is the ledger's answer and holds only what is
 * still outstanding, and the second panel is what has been raised and has not
 * reached the books. An invoice missing from both is an invoice that is settled.
 */

interface OpenItem {
  sourceId: string;
  memo: string;
  date: string;
  dueDate: string | null;
  outstandingMinor: string;
  daysOld: number;
  daysOverdue: number;
}

interface Ageing {
  asOf: string;
  buckets: Record<string, string>;
  totalMinor: string;
  overdueMinor: string;
  open: OpenItem[];
}

const BUCKETS: { key: string; label: string; hint: string }[] = [
  { key: "current", label: "Current", hint: "0–30 days" },
  { key: "d31_60", label: "31–60", hint: "one month late" },
  { key: "d61_90", label: "61–90", hint: "two months late" },
  { key: "d91_120", label: "91–120", hint: "three months late" },
  { key: "over120", label: "120+", hint: "provision territory" },
];

export default function ReceivablesPage() {
  const { currentEntity } = useAppState();
  const entityId = currentEntity?.id;

  const [asOf, setAsOf] = React.useState(() => new Date().toISOString().slice(0, 10));
  const [receivingId, setReceivingId] = React.useState<string | null>(null);
  const [postingId, setPostingId] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [actionError, setActionError] = React.useState<string | null>(null);

  const ageing = useLedgerQuery<Ageing>(
    entityId ? `/api/ledger/ar/ageing?entityId=${entityId}&asOf=${asOf}` : null,
  );
  const { invoices, loading: invoicesLoading } = useInvoices((i) => i.direction === "OUTBOUND");

  /* Which invoices have reached the books, read off the receivables control
   * account itself — one line of it is debited by every invoice that posts, and
   * that line carries the document's own id. Asked for only once there is a
   * document whose state is in question, because a thousand ledger lines is a
   * real read. */
  const ledger = useSalesLedger(invoices.length > 0 ? entityId : undefined);

  /* Raised, belongs in the ledger, and the read covered its date without
   * finding it. An invoice the read did not reach is left out of this list
   * rather than counted as unposted: the panel below acts on it, and acting on
   * a guess is how somebody posts what is already posted. */
  const unposted = React.useMemo(
    () =>
      ledger.index?.complete
        ? invoices.filter((i) => isPostable(i) && !ledger.index?.postings.has(i.id))
        : [],
    [invoices, ledger.index],
  );

  /* How many of the invoices raised the books do carry. It is what separates
   * "everything posted has been paid" from "nothing was ever posted", and the
   * two sound identical on an empty report. */
  const postedCount = React.useMemo(() => {
    const index = ledger.index;
    return index ? invoices.filter((i) => index.postings.has(i.id)).length : 0;
  }, [invoices, ledger.index]);

  const byId = React.useMemo(() => new Map(invoices.map((i) => [i.id, i])), [invoices]);

  const reload = () => {
    ageing.reload();
    ledger.reload();
  };

  /** Put one invoice on the books, and say which of the two things happened. */
  const post = async (invoice: Invoice) => {
    setPostingId(invoice.id);
    setActionError(null);
    try {
      const entry = await postInvoiceToLedger(invoice.id);
      setNotice(
        entry.alreadyPosted
          ? `${invoice.number} was already in the ledger as ${entry.reference}. Nothing was posted twice.`
          : `${invoice.number} posted as ${entry.reference}. It is in the ageing from its own issue date.`,
      );
      reload();
    } catch (e) {
      setActionError(`${invoice.number} could not be posted. ${ledgerProblem(e)}`);
    } finally {
      setPostingId(null);
    }
  };

  /**
   * Post every invoice that has been raised and not posted.
   *
   * One at a time, because there is no batch route and because a refusal on the
   * fourth must not decide anything about the first three — each posting is its
   * own entry under its own idempotency key. What was posted and what was
   * already there are counted separately: they are different facts, and adding
   * them together would report that the books changed when they did not.
   */
  const postAll = async () => {
    setActionError(null);
    let posted = 0;
    let already = 0;
    let failed = 0;
    let firstProblem: string | null = null;
    for (const invoice of unposted) {
      setPostingId(invoice.id);
      try {
        const entry = await postInvoiceToLedger(invoice.id);
        if (entry.alreadyPosted) already++;
        else posted++;
      } catch (e) {
        failed++;
        firstProblem ??= `${invoice.number} could not be posted. ${ledgerProblem(e)}`;
      }
    }
    setPostingId(null);
    setNotice(
      `${posted} posted to the ledger` +
        (already > 0 ? `, ${already} already there and left alone` : "") +
        (failed > 0 ? `, ${failed} refused` : "") +
        ".",
    );
    if (firstProblem) setActionError(firstProblem);
    reload();
  };

  if (!entityId) return <Loading label="Choosing an entity…" />;

  /* Bound once so the narrowing survives into the callbacks below: inside a
   * `.map` TypeScript can no longer see that `ageing.data` was checked. */
  const report = ageing.data;
  const openItems = report?.open ?? [];
  const overdue = report ? BigInt(report.overdueMinor) : 0n;

  return (
    <>
      <PageHead
        title="Receivables"
        sub="What customers still owe, netted document by document straight from the ledger. A receipt is matched to the invoice it settles, so a paid invoice leaves this report rather than lingering in it."
        actions={
          <label className="flex items-center gap-1.5">
            <span className="sw-label">As at</span>
            <input
              type="date"
              className="sw-input"
              style={{ width: "9.5rem" }}
              value={asOf}
              onChange={(e) => setAsOf(e.target.value)}
            />
          </label>
        }
      />

      {notice && <div className="sw-note mb-3" role="status" data-testid="ar-notice">{notice}</div>}
      {actionError && <ErrorNote>{actionError}</ErrorNote>}
      {ageing.error && <ErrorNote>{ageing.error}</ErrorNote>}
      {ledger.error && <ErrorNote>{ledger.error}</ErrorNote>}

      {ageing.loading && !report && <Loading />}

      {report && (
        <Panel className="mb-4 p-4">
          <div className="sw-label">Ageing</div>
          <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 lg:grid-cols-6">
            {BUCKETS.map((b) => (
              <div key={b.key}>
                <div className="sw-label">{b.label}</div>
                <div className="mt-0.5 text-[0.9375rem] font-semibold tabular-nums">
                  <Figure minor={report.buckets[b.key] ?? "0"} />
                </div>
                <div className="text-[0.6875rem]" style={{ color: "var(--sw-fg-faint)" }}>{b.hint}</div>
              </div>
            ))}
            <div style={{ borderInlineStart: "2px solid var(--sw-line-strong)", paddingInlineStart: "0.75rem" }}>
              <div className="sw-label">Total owed to us</div>
              <div className="mt-0.5 text-[1.0625rem] font-semibold tabular-nums" data-testid="ageing-total">
                <Figure minor={report.totalMinor} zero="zero" />
              </div>
            </div>
          </div>
          {/* The bands measure age from the document date, which is not the same
              question as whether anything is late. Only the due date answers
              that, and it is carried onto the entry when an invoice is posted. */}
          <p className="sw-sub mt-3">
            {overdue > 0n ? (
              <>Of that, <Figure minor={overdue} /> is past the date we gave the customer.</>
            ) : (
              "Nothing is past the date we gave, on the invoices that carry one."
            )}
          </p>
        </Panel>
      )}

      {report &&
        (openItems.length === 0 ? (
          <Empty>
            {/* Four different silences, and the old screen said the same thing
                for all of them. Which one this is depends on what has been
                raised and what has reached the books, so both are counted
                before anything is claimed. */}
            {invoices.length === 0
              ? "No sales invoice has been raised yet. This is not a statement that nothing is owed — it is a statement that nothing has been recorded."
              : ledger.loading
                ? `Nothing is outstanding as at ${report.asOf}. Still reading what has been posted, which is what says whether that is good news.`
                : !ledger.index
                  ? `Nothing is outstanding as at ${report.asOf}. Whether anything has ever been posted could not be checked, so this is the ageing's answer and not the whole story.`
                  : postedCount === 0
                    ? `${unposted.length === 1 ? "One invoice has" : `${unposted.length} invoices have`} been raised and none has reached the ledger, so this report is empty for want of a posting rather than because nothing is owed. Post them below.`
                    : unposted.length > 0
                      ? `Every invoice that has been posted is settled. ${unposted.length === 1 ? "One invoice has" : `${unposted.length} invoices have`} been raised and not posted, and nothing they contain is counted here.`
                      : "Nothing is outstanding. Every invoice that has reached the ledger has been settled."}
          </Empty>
        ) : (
          <Panel className="mb-4 overflow-hidden">
            <div className="sw-scroll">
              <table className="sw-table">
                <caption className="sr-only">Open items as at {report.asOf}</caption>
                <thead>
                  <tr>
                    <th style={{ width: "7rem" }}>Raised</th>
                    <th style={{ width: "7rem" }}>Due</th>
                    <th>Document</th>
                    <th className="sw-num" style={{ width: "5.5rem" }}>Age</th>
                    <th className="sw-num" style={{ width: "6.5rem" }}>Overdue</th>
                    <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Outstanding</th>
                    <th style={{ width: "8rem" }}><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {openItems.map((o) => {
                    const amount = BigInt(o.outstandingMinor);
                    const invoice = byId.get(o.sourceId);
                    return (
                      <React.Fragment key={o.sourceId}>
                        <tr>
                          <td>{o.date}</td>
                          <td>{o.dueDate ?? <span className="sw-zero">–</span>}</td>
                          <td className="max-w-0 truncate" title={o.memo || o.sourceId}>
                            {invoice ? (
                              <Link href={`/invoices/${encodeURIComponent(o.sourceId)}`} className="sw-link">
                                {o.memo || o.sourceId}
                              </Link>
                            ) : (
                              o.memo || o.sourceId
                            )}
                            {/* An unapplied credit is a real thing, not a rounding
                                artefact — say so rather than showing a bare minus. */}
                            {amount < 0n && <span className="sw-chip ms-1">unapplied credit</span>}
                          </td>
                          <td className="sw-num">{o.daysOld} d</td>
                          <td className="sw-num">
                            {o.daysOverdue > 0 ? (
                              <span className="sw-chip sw-chip-bad">{o.daysOverdue} d late</span>
                            ) : (
                              <span className="sw-zero">–</span>
                            )}
                          </td>
                          <td className="sw-num"><Figure minor={o.outstandingMinor} /></td>
                          <td>
                            {/* Only against something that is owed. A credit
                                standing on the account is settled by allocating
                                it, which is a decision and not a receipt. */}
                            {amount > 0n && (
                              <button
                                type="button"
                                className="sw-btn sw-btn-sm"
                                aria-expanded={receivingId === o.sourceId}
                                data-testid={`receive-${o.sourceId}`}
                                onClick={() => {
                                  setReceivingId(receivingId === o.sourceId ? null : o.sourceId);
                                  setNotice(null);
                                  setActionError(null);
                                }}
                              >
                                {receivingId === o.sourceId ? "Close" : "Receive"}
                              </button>
                            )}
                          </td>
                        </tr>
                        {receivingId === o.sourceId && (
                          <tr>
                            <td colSpan={7} style={{ background: "var(--sw-ground)" }}>
                              <CustomerReceipt
                                key={o.sourceId}
                                entityId={entityId}
                                invoiceId={o.sourceId}
                                invoiceLabel={
                                  invoice
                                    ? `${invoice.number} — ${invoice.buyer?.nameEn ?? "customer"}`
                                    : o.memo || o.sourceId
                                }
                                outstandingMinor={o.outstandingMinor}
                                onCancel={() => setReceivingId(null)}
                                onPosted={(result, amountMinor) => {
                                  setReceivingId(null);
                                  setNotice(
                                    result.alreadyPosted
                                      ? `A receipt of that amount on that date against ${invoice?.number ?? "this invoice"} is already on the books as ${result.reference}. Nothing moved a second time — date or split the second one to post it separately.`
                                      : `${fmtMinor(amountMinor)} received against ${invoice?.number ?? "the invoice"} as ${result.reference}.`,
                                  );
                                  reload();
                                }}
                              />
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr>
                    <th scope="row" colSpan={5} style={{ textAlign: "end" }}>Total</th>
                    <td className="sw-num" data-testid="ageing-foot"><Figure minor={report.totalMinor} zero="zero" /></td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
            <p className="sw-sub px-3 py-2" style={{ borderTop: "1px solid var(--sw-line)" }}>
              This ties to account {AR_CONTROL} Trade receivables on the trial balance —{" "}
              <Link href={`/accounting/accounts/${AR_CONTROL}`} className="sw-link">open the control account</Link>{" "}
              to see every movement behind it.
            </p>
          </Panel>
        ))}

      {/* Raised and not on the books. Nothing in this list is in the ageing
          above, in the VAT return or on the trial balance, and that is the
          whole reason it is here. */}
      {invoicesLoading && invoices.length === 0 && <Loading label="Reading the invoices…" />}

      {unposted.length > 0 && (
        <>
          <div className="mt-6 flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="sw-title" style={{ fontSize: "1.0625rem" }}>Raised, not in the ledger</h2>
              <p className="sw-sub mb-3 mt-1 max-w-[80ch]">
                {unposted.length === 1 ? "One invoice has" : `${unposted.length} invoices have`} been issued
                and never posted. Until they are, the ageing, the statements, the VAT return and the trial
                balance do not know they exist.
              </p>
            </div>
            {unposted.length > 1 && (
              <button
                type="button"
                className="sw-btn"
                disabled={postingId !== null}
                aria-disabled={postingId !== null || undefined}
                data-testid="post-all"
                onClick={postAll}
              >
                {postingId !== null ? "Posting…" : `Post all ${unposted.length}`}
              </button>
            )}
          </div>
          <Panel className="overflow-hidden">
            <div className="sw-scroll">
              <table className="sw-table">
                <caption className="sr-only">Invoices raised that have not reached the ledger</caption>
                <thead>
                  <tr>
                    <th style={{ width: "9rem" }}>Number</th>
                    <th>Customer</th>
                    <th style={{ width: "7rem" }}>Issued</th>
                    <th style={{ width: "7rem" }}>Due</th>
                    <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Payable</th>
                    <th style={{ width: "7rem" }}><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {unposted.map((invoice) => (
                    <tr key={invoice.id}>
                      <td className="sw-code">
                        <Link href={`/invoices/${encodeURIComponent(invoice.id)}`} className="sw-link">
                          {invoice.number}
                        </Link>
                        {invoice.docType === "TAX_CREDIT_NOTE" && <span className="sw-chip ms-1">credit</span>}
                      </td>
                      <td className="max-w-0 truncate" title={invoice.buyer?.nameEn}>{invoice.buyer?.nameEn}</td>
                      <td>{invoice.issueDate}</td>
                      <td>{invoice.dueDate ?? <span className="sw-zero">–</span>}</td>
                      <td className="sw-num">
                        <Figure minor={invoice.totals.payableMinor} currency={invoice.currency} colour={false} />
                        {invoice.currency !== "AED" && <span className="sw-code ms-1">{invoice.currency}</span>}
                      </td>
                      <td>
                        <button
                          type="button"
                          className="sw-btn sw-btn-sm sw-btn-primary"
                          disabled={postingId !== null}
                          aria-disabled={postingId !== null || undefined}
                          data-testid={`post-${invoice.id}`}
                          onClick={() => post(invoice)}
                        >
                          {postingId === invoice.id ? "Posting…" : "Post"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        </>
      )}

      {ledger.index && !ledger.index.complete && (
        <p className="sw-sub mt-3 max-w-[80ch]">
          Account {AR_CONTROL} holds {ledger.index.movements} movements and this read took the most recent{" "}
          {ledger.index.read}. An invoice older than those cannot be shown here as posted or unposted, only
          as unread, so this screen does not offer to post any of them —{" "}
          <Link href={`/accounting/accounts/${AR_CONTROL}`} className="sw-link">the control account</Link>{" "}
          holds the rest, and the invoice&apos;s own screen will post it.
        </p>
      )}
    </>
  );
}
