"use client";

import * as React from "react";
import Link from "next/link";
import { useAppState } from "@/lib/app-state";
import { useInvoices } from "@/hooks/use-entity-data";
import { useLedgerQuery } from "@/components/ledger/use-ledger";
import { Figure, PageHead, Panel, ErrorNote, Loading, Empty } from "@/components/ledger/primitives";
import { BillEntry } from "@/components/ledger/ap-bill-entry";
import { BillCoding, type PostBillResult } from "@/components/ledger/ap-post-bill";
import { SupplierPayment, type PaymentResult } from "@/components/ledger/ap-payment";
import { fmtMinor } from "@/lib/ledger/format";
import type { Invoice } from "@/lib/domain/types";

/**
 * Payables — what is owed, and the two things that put it there.
 *
 * The subledger behind this screen has been able to post a bill and a supplier
 * payment for as long as it has existed, and nothing could reach it: there was
 * no way to enter a bill, so the ageing, the three-way match, the payment run
 * and input VAT recovery were all fed by an empty set. So this screen carries
 * the whole working loop — receive the document, code it, post it, pay it —
 * rather than only reporting on a ledger somebody else was expected to fill.
 *
 * The report and the register are deliberately two lists. The ageing is the
 * ledger's answer and shows only what is still outstanding; the register is
 * every bill this entity has received, whether or not it has ever been posted.
 * A screen that showed only the first cannot tell "nothing is owed" from
 * "nothing was ever entered", and those are opposite facts.
 */

/** The control account the ageing explains — `AP_CONTROL` in server/ledger/ap.ts. */
const AP_CONTROL = "2000";

/**
 * How far back the posting state is read.
 *
 * `generalLedger` caps a page at a thousand lines and reports whether more
 * matched, taking them from the newest end. Where it truncates, a bill missing
 * from the answer is a bill this read did not reach rather than a bill nobody
 * posted — a different sentence, and the register says the one it can prove.
 */
const CONTROL_READ_LIMIT = 1000;

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

interface ControlLine {
  entryId: string;
  reference: string;
  source: string;
  sourceId: string | null;
  status: string;
}

interface ControlLedger {
  truncated: boolean;
  lineCount: number;
  lines: ControlLine[];
}

const BUCKETS: { key: string; label: string; hint: string }[] = [
  { key: "current", label: "Current", hint: "0–30 days" },
  { key: "d31_60", label: "31–60", hint: "one month old" },
  { key: "d61_90", label: "61–90", hint: "two months old" },
  { key: "d91_120", label: "91–120", hint: "three months old" },
  { key: "over120", label: "120+", hint: "somebody has stopped chasing" },
];

/**
 * What the ledger can be shown to say about one received document.
 *
 * Four states rather than two, because "we have not looked yet" and "we looked
 * and it is not there" are different facts and only one of them is a reproach.
 */
type LedgerState =
  | { kind: "posted"; entryId: string; reference: string; status: string }
  | { kind: "absent" }
  | { kind: "checking" }
  | { kind: "unread"; why: string };

export default function PayablesPage() {
  const { currentEntity } = useAppState();
  const entityId = currentEntity?.id;

  const [asOf, setAsOf] = React.useState(() => new Date().toISOString().slice(0, 10));
  const [entering, setEntering] = React.useState(false);
  const [codingId, setCodingId] = React.useState<string | null>(null);
  const [payingId, setPayingId] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  const ageing = useLedgerQuery<Ageing>(
    entityId ? `/api/ledger/ap/ageing?entityId=${entityId}&asOf=${asOf}` : null,
  );
  const { invoices: bills, loading: billsLoading } = useInvoices((i) => i.direction === "INBOUND");

  /* The posting state of every bill, read off the payables control account:
   * one line of it is credited by every bill that posts, and the line carries
   * the document's own id.
   *
   * Asked for only once there is a document whose state is in question, and
   * narrowed to the day the oldest of them was issued — a bill's entry is dated
   * on the bill, so nothing outside that window can be one of these bills'
   * postings, and leaving the window open would spend the read's thousand lines
   * on years of movements that answer nothing. */
  const from = bills.reduce<string | null>(
    (oldest, b) => (oldest === null || b.issueDate < oldest ? b.issueDate : oldest),
    null,
  );
  const control = useLedgerQuery<ControlLedger>(
    entityId && from
      ? `/api/ledger/accounts/${AP_CONTROL}?entityId=${entityId}&from=${from}&limit=${CONTROL_READ_LIMIT}`
      : null,
    [bills.length],
  );

  const posted = React.useMemo(() => {
    const map = new Map<string, { entryId: string; reference: string; status: string }>();
    for (const line of control.data?.lines ?? []) {
      if (line.source !== "bill" || !line.sourceId) continue;
      /* The first one wins, and the read comes back oldest first, so what is
       * kept is the entry the bill made rather than the one that reversed it.
       * A reversal copies the document's id onto itself, so the later line
       * would otherwise report a reversed bill as freshly posted. */
      if (!map.has(line.sourceId)) {
        map.set(line.sourceId, { entryId: line.entryId, reference: line.reference, status: line.status });
      }
    }
    return map;
  }, [control.data]);

  const ledgerStateOf = (bill: Invoice): LedgerState => {
    const hit = posted.get(bill.id);
    if (hit) return { kind: "posted", entryId: hit.entryId, reference: hit.reference, status: hit.status };
    if (control.error) return { kind: "unread", why: "unknown" };
    if (!control.data) return { kind: "checking" };
    // Nothing was found. Whether that means "nobody posted it" depends on
    // whether the read reached the whole account.
    return control.data.truncated ? { kind: "unread", why: "beyond this read" } : { kind: "absent" };
  };

  const byId = React.useMemo(() => new Map(bills.map((b) => [b.id, b])), [bills]);
  const unposted = bills.filter((b) => ledgerStateOf(b).kind === "absent");

  const reload = () => {
    ageing.reload();
    control.reload();
  };

  if (!entityId || !currentEntity) return <Loading label="Choosing an entity…" />;

  /* Bound once so the narrowing survives into the callbacks below: inside a
   * `.map` TypeScript can no longer see that `ageing.data` was checked. */
  const report = ageing.data;
  const openItems = report?.open ?? [];
  const overdue = report ? BigInt(report.overdueMinor) : 0n;

  return (
    <>
      <PageHead
        title="Payables"
        sub="What we still owe suppliers, netted bill by bill from the ledger. Posting a bill is idempotent on its id, which is what stops the same supplier invoice being paid twice."
        actions={
          <>
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
            <button
              type="button"
              className="sw-btn sw-btn-primary"
              data-testid="enter-bill"
              onClick={() => { setEntering((v) => !v); setNotice(null); }}
            >
              {entering ? "Close" : "Enter a bill"}
            </button>
          </>
        }
      />

      {notice && <div className="sw-note mb-3" role="status" data-testid="ap-notice">{notice}</div>}
      {ageing.error && <ErrorNote>{ageing.error}</ErrorNote>}
      {control.error && <ErrorNote>{control.error}</ErrorNote>}

      {entering && (
        <BillEntry
          entity={currentEntity}
          onCancel={() => setEntering(false)}
          onSaved={(bill) => {
            setEntering(false);
            setCodingId(bill.id);
            setNotice(
              `${bill.number} from ${bill.seller.nameEn} saved. It is not in the ledger yet — code its lines below and post it.`,
            );
            reload();
          }}
        />
      )}

      {ageing.loading && !ageing.data && <Loading />}

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
              <div className="sw-label">Total we owe</div>
              <div className="mt-0.5 text-[1.0625rem] font-semibold tabular-nums" data-testid="ageing-total">
                <Figure minor={report.totalMinor} zero="zero" />
              </div>
            </div>
          </div>
          {/* The bands measure age from the document date, which is not the same
              question as whether anything is late. Only the due date answers
              that, and it is carried onto the entry when a bill is posted. */}
          {openItems.length > 0 && (
            <p className="sw-sub mt-3">
              {overdue > 0n
                ? <>Of that, <Figure minor={overdue} /> is past the date the supplier gave.</>
                : "Nothing is past the date its supplier gave, on the bills that carry one."}
            </p>
          )}
        </Panel>
      )}

      {report && (openItems.length === 0 ? (
        <Empty>
          {bills.length === 0
            ? "No supplier bill has been entered yet. This is not a statement that nothing is owed — it is a statement that nothing has been recorded. Enter the first one above."
            : unposted.length === bills.length
              ? `${bills.length === 1 ? "One bill has" : `${bills.length} bills have`} been entered and none has reached the ledger, so this report is empty for want of a posting rather than because nothing is owed. Code and post them below.`
              : unposted.length > 0
                ? `Every bill that has been posted is settled. ${unposted.length === 1 ? "One bill has" : `${unposted.length} bills have`} been entered and not posted, and nothing they contain is counted here.`
                : "Nothing is outstanding. Every bill that has reached the ledger has been paid."}
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
                  <th style={{ width: "7rem" }}><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {openItems.map((o) => {
                  const amount = BigInt(o.outstandingMinor);
                  const bill = byId.get(o.sourceId);
                  return (
                    <React.Fragment key={o.sourceId}>
                      <tr>
                        <td>{o.date}</td>
                        <td>{o.dueDate ?? <span className="sw-zero">–</span>}</td>
                        <td className="max-w-0 truncate" title={o.memo || o.sourceId}>
                          {bill ? (
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
                          {o.daysOverdue > 0
                            ? <span className="sw-chip sw-chip-bad">{o.daysOverdue} d late</span>
                            : <span className="sw-zero">–</span>}
                        </td>
                        <td className="sw-num"><Figure minor={o.outstandingMinor} /></td>
                        <td>
                          {/* Paying goes through the bill's own document — the
                              route reads the entity and the number off it — so
                              an open item whose document is not in the store
                              has no payment to offer, and the memo beside it is
                              already plain text rather than a link. */}
                          {bill && amount > 0n && (
                            <button
                              type="button"
                              className="sw-btn sw-btn-sm"
                              aria-expanded={payingId === o.sourceId}
                              data-testid={`pay-${o.sourceId}`}
                              onClick={() => {
                                setPayingId(payingId === o.sourceId ? null : o.sourceId);
                                setNotice(null);
                              }}
                            >
                              {payingId === o.sourceId ? "Close" : "Pay"}
                            </button>
                          )}
                        </td>
                      </tr>
                      {payingId === o.sourceId && (
                        <tr>
                          <td colSpan={7} style={{ background: "var(--sw-ground)" }}>
                            <SupplierPayment
                              entityId={entityId}
                              billId={o.sourceId}
                              billLabel={bill ? `${bill.number} — ${bill.seller?.nameEn ?? "supplier"}` : o.memo || o.sourceId}
                              outstandingMinor={o.outstandingMinor}
                              onCancel={() => setPayingId(null)}
                              onPosted={(result: PaymentResult, amountMinor) => {
                                setPayingId(null);
                                setNotice(
                                  result.alreadyPosted
                                    ? `That reference has already been posted, as ${result.reference}. Nothing moved a second time.`
                                    : `${fmtMinor(amountMinor)} recorded against ${bill?.number ?? "the bill"} as ${result.reference}.`,
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
            This ties to account {AP_CONTROL} Trade payables on the trial balance —{" "}
            <Link href={`/accounting/accounts/${AP_CONTROL}`} className="sw-link">open the control account</Link>{" "}
            to see every movement behind it.
          </p>
        </Panel>
      ))}

      <h2 className="sw-title mt-6" style={{ fontSize: "1.0625rem" }}>Bills received</h2>
      <p className="sw-sub mb-3 mt-1 max-w-[80ch]">
        Every purchase document entered for this entity, and whether the ledger has it. A bill that has not been
        posted is on no report: not this ageing, not input VAT recovery, not the payment run.
      </p>

      {billsLoading && bills.length === 0 && <Loading label="Reading the bills…" />}

      {!billsLoading && bills.length === 0 && (
        <Empty>
          Nothing has been received yet. A bill entered here is stored as the supplier sent it; posting it is the
          separate step that puts the cost and the liability into the books.
        </Empty>
      )}

      {bills.length > 0 && (
        <Panel className="overflow-hidden">
          <div className="sw-scroll">
            <table className="sw-table">
              <caption className="sr-only">Bills received, and whether each has been posted</caption>
              <thead>
                <tr>
                  <th style={{ width: "9rem" }}>Number</th>
                  <th>Supplier</th>
                  <th style={{ width: "7rem" }}>Issued</th>
                  <th style={{ width: "7rem" }}>Due</th>
                  <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Payable</th>
                  <th style={{ width: "13rem" }}>In the ledger</th>
                  <th style={{ width: "8rem" }}><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {bills.map((bill) => {
                  const state = ledgerStateOf(bill);
                  return (
                    <React.Fragment key={bill.id}>
                      <tr>
                        <td className="sw-code">
                          <Link href={`/invoices/${encodeURIComponent(bill.id)}`} className="sw-link">
                            {bill.number}
                          </Link>
                          {bill.docType === "TAX_CREDIT_NOTE" && <span className="sw-chip ms-1">credit</span>}
                        </td>
                        <td className="max-w-0 truncate" title={bill.seller?.nameEn}>{bill.seller?.nameEn}</td>
                        <td>{bill.issueDate}</td>
                        <td>{bill.dueDate ?? <span className="sw-zero">–</span>}</td>
                        <td className="sw-num">
                          <Figure minor={bill.totals.payableMinor} currency={bill.currency} colour={false} />
                          {bill.currency !== "AED" && <span className="sw-code ms-1">{bill.currency}</span>}
                        </td>
                        <td>
                          {state.kind === "posted" ? (
                            <>
                              <span className={`sw-chip ${state.status === "reversed" ? "sw-chip-warn" : "sw-chip-ok"}`}>
                                {state.status}
                              </span>
                              <Link
                                href={`/accounting/journals?entry=${encodeURIComponent(state.entryId)}`}
                                className="sw-link sw-code ms-1"
                              >
                                {state.reference}
                              </Link>
                            </>
                          ) : state.kind === "absent" ? (
                            <span className="sw-chip sw-chip-warn">not posted</span>
                          ) : state.kind === "checking" ? (
                            <span className="sw-chip">checking</span>
                          ) : (
                            <span className="sw-chip">{state.why}</span>
                          )}
                        </td>
                        <td>
                          {state.kind !== "posted" && (
                            <button
                              type="button"
                              className="sw-btn sw-btn-sm sw-btn-primary"
                              aria-expanded={codingId === bill.id}
                              data-testid={`code-${bill.id}`}
                              onClick={() => {
                                setCodingId(codingId === bill.id ? null : bill.id);
                                setNotice(null);
                              }}
                            >
                              {codingId === bill.id ? "Close" : "Code & post"}
                            </button>
                          )}
                        </td>
                      </tr>
                      {codingId === bill.id && (
                        <tr>
                          <td colSpan={7} style={{ background: "var(--sw-ground)" }}>
                            <BillCoding
                              key={bill.id}
                              entityId={entityId}
                              bill={bill}
                              onCancel={() => setCodingId(null)}
                              onPosted={(result: PostBillResult) => {
                                setCodingId(null);
                                const rc = BigInt(result.reverseChargeMinor);
                                setNotice(
                                  (result.alreadyPosted
                                    ? `${bill.number} was already in the ledger as ${result.reference}. Nothing was posted twice.`
                                    : `${bill.number} posted as ${result.reference}.`) +
                                    (rc !== 0n
                                      ? ` ${fmtMinor(rc)} of reverse charge went to both boxes of the return — output and recoverable — so it nets to nothing in cash.`
                                      : ""),
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
            </table>
          </div>
          {control.data?.truncated && (
            <p className="sw-sub px-3 py-2" style={{ borderTop: "1px solid var(--sw-line)" }}>
              Account {AP_CONTROL} has moved {control.data.lineCount} times since {from}, and this read took the most
              recent {CONTROL_READ_LIMIT} of them. Anything before that cannot be shown here as posted or unposted,
              only as beyond the read —{" "}
              <Link href={`/accounting/accounts/${AP_CONTROL}`} className="sw-link">the control account</Link>{" "}
              holds the rest.
            </p>
          )}
        </Panel>
      )}
    </>
  );
}
