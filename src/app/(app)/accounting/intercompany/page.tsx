"use client";

import * as React from "react";
import { useLedgerQuery } from "@/components/ledger/use-ledger";
import { Figure, PageHead, Panel, ErrorNote, Loading, Empty } from "@/components/ledger/primitives";

/**
 * Intercompany matching and elimination on screen.
 *
 * The order of the page is the order of the argument. What was matched, and on
 * what evidence, comes first — because every figure below it depends on those
 * pairings being right, and the reader has to be able to reject one. Then what
 * could NOT be matched, by entity and by side, because that is the part a group
 * accountant chases in the fortnight before signing. Then the elimination
 * schedule, and immediately under it, unmissable, the statement that it has not
 * been posted anywhere and why.
 *
 * Confidence is never shown as a bare word. Every match carries the evidence
 * that produced it, in a row of its own under the figures, so the answer to
 * "why do you think these are the same transaction" is on the same screen as
 * the claim.
 */

type Confidence = "certain" | "high" | "probable" | "possible";
type Side = "receivable" | "payable";

interface Evidence { kind: string; detail: string }
interface PostingRef {
  entityId: string; side: Side; documentKey: string; reference: string; date: string; memo: string;
  accountCode: string; grossMinor: string; outstandingMinor: string;
  tradeMinor: string; tradeCodes: string[]; capitalisedMinor: string;
  counterpartyCode: string | null; counterpartyName: string | null;
  counterpartyEntityId: string | null; attributionBasis: string | null;
}
interface Match {
  receivable: PostingRef; payable: PostingRef; confidence: Confidence;
  dateGapDays: number; amountDifferenceMinor: string; evidence: Evidence[]; basis: string;
}
interface Unmatched extends PostingRef { finding: string; attributedToMember: boolean }
interface EntitySide {
  entityId: string; side: Side; matchedCount: number; matchedMinor: string;
  unmatchedCount: number; unmatchedMinor: string; totalMinor: string;
}
interface ConfidenceRow { confidence: Confidence; count: number; amountMinor: string; meaning: string }
interface Member { entityId: string; ownershipBps: number; isParent: boolean; legalName: string | null; trn: string | null }
interface Report {
  groupCode: string; groupName: string; currency: string; from: string; to: string;
  members: Member[]; matches: Match[]; unmatched: Unmatched[];
  totals: {
    matchedCount: number; matchedMinor: string; unmatchedReceivableMinor: string;
    unmatchedPayableMinor: string; unmatchedAttributedMinor: string; carriedDifferenceMinor: string;
  };
  warnings: string[];
  byEntity: EntitySide[]; byConfidence: ConfidenceRow[];
  control: { entityId: string; receivableMinor: string; payableMinor: string }[];
  summary: string;
}
interface EliminationLine {
  entityId: string | null; accountCode: string; accountName: string;
  debitMinor: string; creditMinor: string; memo: string;
}
interface EliminationEntry {
  key: string; kind: string; authority: string; narrative: string;
  confidence: Confidence; lines: EliminationLine[]; totalMinor: string;
}
interface Schedule {
  groupCode: string; currency: string; from: string; asOf: string;
  entries: EliminationEntry[]; totalDebitMinor: string; totalCreditMinor: string;
  balanced: boolean; posted: boolean; postingNote: string; warnings: string[];
}
interface StockRow {
  sellerEntityId: string; holderEntityId: string; item: string; quantity: string;
  unitTransferPriceMinor: string; unitCostMinor: string; carryingAmountMinor: string;
  costToGroupMinor: string; unrealisedProfitMinor: string; marginBps: string | null;
  basis: string; basisNote: string;
}
interface Unrealised {
  rows: StockRow[]; totalCarryingMinor: string; totalCostMinor: string;
  totalUnrealisedProfitMinor: string; elimination: EliminationEntry | null;
  inputNote: string; warnings: string[];
}
interface GroupSummary { code: string; name: string; currency: string; memberCount: number; parentEntityId: string | null }

/** A stock line as it is being typed, before it is a query parameter. */
interface StockInput { seller: string; holder: string; quantity: string; price: string; cost: string }

const EMPTY_STOCK: StockInput = { seller: "", holder: "", quantity: "", price: "", cost: "" };

const TONE: Record<Confidence, string> = {
  // Red on the weakest tier deliberately: it is the row most likely to be
  // wrong, and it is the one that has to be looked at before it is believed.
  certain: "sw-chip-accent",
  high: "sw-chip-ok",
  probable: "sw-chip-warn",
  possible: "sw-chip-bad",
};

const KIND_LABEL: Record<string, string> = {
  trade_balance: "Receivable against payable",
  trade_result: "Revenue against cost of sales",
  dividend: "Dividend within the group",
  unrealised_profit: "Profit still in stock",
};

function thisYear() {
  const now = new Date();
  return { from: `${now.getUTCFullYear()}-01-01`, to: now.toISOString().slice(0, 10) };
}

export default function IntercompanyPage() {
  const [range, setRange] = React.useState(thisYear);
  const [group, setGroup] = React.useState("");
  const [stock, setStock] = React.useState<StockInput[]>([]);
  const [draft, setDraft] = React.useState<StockInput>(EMPTY_STOCK);
  const [msg, setMsg] = React.useState<string | null>(null);

  const groups = useLedgerQuery<{ groups: GroupSummary[] }>("/api/ledger/intercompany");
  const list = groups.data?.groups ?? [];

  React.useEffect(() => {
    if (group || !list.length) return;
    setGroup(list[0].code);
  }, [list, group]);

  const stockParams = stock
    .map((s) => `&stock=${encodeURIComponent([s.seller, s.holder, s.quantity, s.price, s.cost].filter((p, i) => i < 4 || p !== "").join(":"))}`)
    .join("");

  const q = useLedgerQuery<{ report: Report; schedule: Schedule; unrealised?: Unrealised }>(
    group
      ? `/api/ledger/intercompany?group=${encodeURIComponent(group)}&from=${range.from}&to=${range.to}${stockParams}`
      : null,
  );

  const r = q.data?.report;
  const s = q.data?.schedule;
  const u = q.data?.unrealised;
  const members = r?.members ?? [];

  function addStock(e: React.FormEvent) {
    e.preventDefault();
    if (!draft.seller || !draft.holder || !draft.quantity || !draft.price) {
      setMsg("A stock line needs a seller, a holder, a quantity and a transfer price.");
      return;
    }
    setStock((rows) => [...rows, draft]);
    setDraft(EMPTY_STOCK);
    setMsg(
      `Added ${draft.quantity} units sold by ${draft.seller} and still held by ${draft.holder}. ` +
        `The quantity is yours, not the ledger's.`,
    );
  }

  return (
    <>
      <PageHead
        title="Intercompany"
        sub="Trade between members of a group is counted twice in the combined accounts: one member's receivable is another's payable, one's sale is another's purchase. The ledger records no counterparty on a journal line, so nothing here knows that two postings are the same transaction — it finds the evidence, says how strong it is, and leaves the judgement with you."
        actions={
          <>
            <label className="flex items-center gap-1.5">
              <span className="sw-label">Group</span>
              <select className="sw-select" style={{ width: "12rem" }} value={group} data-testid="group-select"
                onChange={(e) => setGroup(e.target.value)}>
                {list.map((g) => <option key={g.code} value={g.code}>{g.name}</option>)}
              </select>
            </label>
            <label className="flex items-center gap-1.5">
              <span className="sw-label">From</span>
              <input type="date" className="sw-input" style={{ width: "9.5rem" }} value={range.from}
                onChange={(e) => setRange((v) => ({ ...v, from: e.target.value }))} />
            </label>
            <label className="flex items-center gap-1.5">
              <span className="sw-label">To</span>
              <input type="date" className="sw-input" style={{ width: "9.5rem" }} value={range.to}
                onChange={(e) => setRange((v) => ({ ...v, to: e.target.value }))} />
            </label>
          </>
        }
      />

      {groups.error && <ErrorNote>{groups.error}</ErrorNote>}
      {q.error && <ErrorNote>{q.error}</ErrorNote>}
      {msg && <div className="sw-note" role="status" data-testid="ic-status">{msg}</div>}
      {(groups.loading || q.loading) && <Loading />}

      {!groups.loading && !groups.error && list.length === 0 && (
        <Empty>
          No consolidation groups have been set up yet. Intercompany matching runs over the members of one group —
          create a group, add the entities that trade with each other, and their balances will pair up here.
        </Empty>
      )}

      {r && s && (
        <div className="grid gap-4">
          <Panel className="overflow-hidden">
            <Head>
              {r.groupName} · {r.from} to {r.to}
            </Head>
            <p className="sw-sub px-3 py-2" role="status" aria-live="polite" data-testid="ic-summary">
              {r.summary}
            </p>
            <div className="sw-scroll">
              <table className="sw-table">
                <caption className="sr-only">What was matched and what was not, for {r.groupName}</caption>
                <thead>
                  <tr>
                    <th>Measure</th>
                    <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Amount</th>
                    <th>What it means</th>
                  </tr>
                </thead>
                <tbody>
                  <Measure label="Matched, counted once" minor={r.totals.matchedMinor} currency={r.currency}
                    note={`${r.totals.matchedCount} pair${r.totals.matchedCount === 1 ? "" : "s"} across the group. Only the amount both sides agree on.`} />
                  <Measure label="Unmatched receivables" minor={r.totals.unmatchedReceivableMinor} currency={r.currency}
                    note="Raised by a member with no member's payable to answer it." />
                  <Measure label="…of which owed by a member" minor={r.totals.unmatchedAttributedMinor} currency={r.currency}
                    note="The sales ledger names a member as the customer. Only a missing posting explains these." />
                  <Measure label="Unmatched payables" minor={r.totals.unmatchedPayableMinor} currency={r.currency}
                    note="Owed by a member with no member's receivable to answer it. May be genuine third-party debt." />
                  <Measure label="Difference the group carries" minor={r.totals.carriedDifferenceMinor} currency={r.currency}
                    note="Unmatched receivables less unmatched payables — what no pairing explains." />
                </tbody>
              </table>
            </div>
          </Panel>

          {r.warnings.length > 0 && (
            <Panel className="overflow-hidden">
              <Head>Read these before using the figures</Head>
              <ul className="grid gap-2 px-3 py-2" data-testid="ic-warnings">
                {r.warnings.map((w, i) => (
                  <li key={i} className="sw-sub" style={{ color: "var(--sw-warn)" }}>{w}</li>
                ))}
              </ul>
            </Panel>
          )}

          {/* ------------------------------------------------- matched pairs */}

          <Panel className="overflow-hidden">
            <Head>Matched pairs — {r.matches.length}</Head>
            <div className="sw-scroll">
              <table className="sw-table">
                <caption className="sr-only">
                  Intragroup pairs, the evidence behind each one and how much of it there is
                </caption>
                <thead>
                  <tr>
                    <th style={{ width: "7rem" }}>Confidence</th>
                    <th style={{ minWidth: "10rem" }}>Receivable in</th>
                    <th style={{ minWidth: "10rem" }}>Payable in</th>
                    <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Raised</th>
                    <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Still open</th>
                    <th className="sw-num" style={{ width: "5rem" }}>Gap</th>
                    <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Difference</th>
                  </tr>
                </thead>
                {r.matches.length === 0 && (
                  <tbody>
                    <tr>
                      <td colSpan={7} className="sw-sub" data-testid="no-matches">
                        Nothing paired up in this period. That is not the same as there being nothing to eliminate —
                        read the unmatched balances below.
                      </td>
                    </tr>
                  </tbody>
                )}
                {r.matches.map((m) => (
                  <tbody key={`${m.receivable.entityId}:${m.receivable.documentKey}`} data-testid="match-row">
                    <tr>
                      <td><span className={`sw-chip ${TONE[m.confidence]}`}>{m.confidence}</span></td>
                      <td>
                        <span className="sw-code">{m.receivable.entityId}</span>{" "}
                        {m.receivable.reference}
                        <span className="sw-sub"> · {m.receivable.date}</span>
                      </td>
                      <td>
                        <span className="sw-code">{m.payable.entityId}</span>{" "}
                        {m.payable.reference}
                        <span className="sw-sub"> · {m.payable.date}</span>
                      </td>
                      <td className="sw-num"><Figure minor={m.receivable.grossMinor} currency={r.currency} /></td>
                      <td className="sw-num"><Figure minor={m.receivable.outstandingMinor} currency={r.currency} /></td>
                      <td className="sw-num">{m.dateGapDays}d</td>
                      <td className="sw-num">
                        <Figure minor={m.amountDifferenceMinor} currency={r.currency} />
                      </td>
                    </tr>
                    <tr>
                      <td colSpan={7} style={{ background: "var(--sw-surface-2)" }}>
                        <ul className="grid gap-1 py-1">
                          {m.evidence.map((e, i) => (
                            <li key={i} className="sw-sub">
                              <span className="sw-label">{e.kind}</span> {e.detail}
                            </li>
                          ))}
                          <li className="sw-sub" style={{ color: "var(--sw-fg-muted)" }}>{m.basis}</li>
                        </ul>
                      </td>
                    </tr>
                  </tbody>
                ))}
              </table>
            </div>
            <div className="sw-scroll" style={{ borderTop: "1px solid var(--sw-line)" }}>
              <table className="sw-table">
                <caption className="sr-only">How many pairs rest on each kind of evidence</caption>
                <thead>
                  <tr>
                    <th style={{ width: "7rem" }}>Tier</th>
                    <th className="sw-num" style={{ width: "5rem" }}>Pairs</th>
                    <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Amount</th>
                    <th>What the tier means</th>
                  </tr>
                </thead>
                <tbody>
                  {r.byConfidence.map((c) => (
                    <tr key={c.confidence} data-testid="confidence-row">
                      <td><span className={`sw-chip ${TONE[c.confidence]}`}>{c.confidence}</span></td>
                      <td className="sw-num">{c.count}</td>
                      <td className="sw-num"><Figure minor={c.amountMinor} currency={r.currency} /></td>
                      <td className="sw-sub">{c.meaning}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>

          {/* ------------------------------------------- unmatched balances */}

          <Panel className="overflow-hidden">
            <Head>Unmatched balances — {r.unmatched.length}</Head>
            <div className="sw-scroll">
              <table className="sw-table">
                <caption className="sr-only">Balances no pair explains, by entity and by side</caption>
                <thead>
                  <tr>
                    <th style={{ width: "9rem" }}>Entity</th>
                    <th style={{ width: "7rem" }}>Side</th>
                    <th style={{ minWidth: "9rem" }}>Document</th>
                    <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Raised</th>
                    <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Still open</th>
                    <th style={{ minWidth: "20rem" }}>What it means</th>
                  </tr>
                </thead>
                <tbody>
                  {r.unmatched.length === 0 && (
                    <tr>
                      <td colSpan={6} className="sw-sub" data-testid="no-unmatched">
                        Every balance on both control accounts paired up. Check the confidence tiers above before
                        reading that as a clean bill of health.
                      </td>
                    </tr>
                  )}
                  {r.unmatched.map((x) => (
                    <tr key={`${x.entityId}:${x.side}:${x.documentKey}`} data-testid="unmatched-row">
                      <td className="sw-code">{x.entityId}</td>
                      <td>
                        {x.side === "receivable" ? "Receivable" : "Payable"}
                        {x.attributedToMember && <span className="sw-chip sw-chip-bad ms-1">member</span>}
                      </td>
                      <td>
                        {x.reference}
                        <span className="sw-sub"> · {x.date}</span>
                      </td>
                      <td className="sw-num"><Figure minor={x.grossMinor} currency={r.currency} /></td>
                      <td className="sw-num"><Figure minor={x.outstandingMinor} currency={r.currency} /></td>
                      <td className="sw-sub">{x.finding}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="sw-scroll" style={{ borderTop: "1px solid var(--sw-line)" }}>
              <table className="sw-table">
                <caption className="sr-only">Matched and unmatched by member and by side</caption>
                <thead>
                  <tr>
                    <th style={{ width: "9rem" }}>Entity</th>
                    <th style={{ width: "7rem" }}>Side</th>
                    <th className="sw-num" style={{ width: "5rem" }}>Matched</th>
                    <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Matched</th>
                    <th className="sw-num" style={{ width: "5rem" }}>Unmatched</th>
                    <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Unmatched</th>
                    <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Raised in period</th>
                    <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Control account</th>
                  </tr>
                </thead>
                <tbody>
                  {r.byEntity.map((row) => {
                    const control = r.control.find((c) => c.entityId === row.entityId);
                    const balance = row.side === "receivable" ? control?.receivableMinor : control?.payableMinor;
                    return (
                      <tr key={`${row.entityId}:${row.side}`} data-testid="by-entity-row">
                        <td className="sw-code">{row.entityId}</td>
                        <td>{row.side === "receivable" ? "Receivable" : "Payable"}</td>
                        <td className="sw-num">{row.matchedCount}</td>
                        <td className="sw-num"><Figure minor={row.matchedMinor} currency={r.currency} /></td>
                        <td className="sw-num">{row.unmatchedCount}</td>
                        <td className="sw-num"><Figure minor={row.unmatchedMinor} currency={r.currency} /></td>
                        <td className="sw-num"><Figure minor={row.totalMinor} currency={r.currency} /></td>
                        <td className="sw-num"><Figure minor={balance ?? "0"} currency={r.currency} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="sw-sub px-3 py-2" style={{ borderTop: "1px solid var(--sw-line)" }}>
              The control-account column is the member&rsquo;s whole balance at {r.to}, group and third party
              together. Matching only ever looks at documents raised inside the period, so the two columns are not
              meant to agree — the gap between them is everything raised before {r.from} and still open.
            </p>
          </Panel>

          {/* ------------------------------------------ elimination schedule */}

          <Panel className="overflow-hidden">
            <Head>
              Elimination schedule as at {s.asOf} — {s.entries.length} entr{s.entries.length === 1 ? "y" : "ies"}
            </Head>
            <div className="sw-note" role="status" aria-live="polite" data-testid="not-posted">
              <strong style={{ color: "var(--sw-fg)" }}>Not posted, and it cannot be.</strong> {s.postingNote}
            </div>
            <div className="sw-scroll">
              <table className="sw-table">
                <caption className="sr-only">The group&rsquo;s elimination journal, which is not posted anywhere</caption>
                <thead>
                  <tr>
                    <th style={{ width: "9rem" }}>Entity</th>
                    <th style={{ width: "5rem" }}>Code</th>
                    <th style={{ minWidth: "11rem" }}>Account</th>
                    <th className="sw-num sw-col-debit" style={{ width: "var(--sw-col-amount)" }}>Debit</th>
                    <th className="sw-num sw-col-credit" style={{ width: "var(--sw-col-amount)" }}>Credit</th>
                    <th style={{ minWidth: "14rem" }}>Memo</th>
                  </tr>
                </thead>
                {s.entries.length === 0 && (
                  <tbody>
                    <tr>
                      <td colSpan={6} className="sw-sub" data-testid="no-eliminations">
                        Nothing to eliminate at {s.asOf}. Either the members did not trade with each other, or the
                        two sides of what they did could not be paired — the table above says which.
                      </td>
                    </tr>
                  </tbody>
                )}
                {s.entries.map((e) => (
                  <tbody key={e.key} data-testid="elimination-entry">
                    <tr>
                      <td colSpan={6} style={{ background: "var(--sw-surface-2)" }}>
                        <span className="sw-label">{KIND_LABEL[e.kind] ?? e.kind}</span>{" "}
                        <span className={`sw-chip ${TONE[e.confidence]}`}>{e.confidence}</span>
                        <p className="sw-sub">{e.narrative}</p>
                        <p className="sw-sub" style={{ color: "var(--sw-fg-faint)" }}>{e.authority}</p>
                      </td>
                    </tr>
                    {e.lines.map((l, i) => (
                      <tr key={i}>
                        <td className="sw-code">{l.entityId ?? "Group"}</td>
                        <td className="sw-code">{l.accountCode}</td>
                        <td>{l.accountName}</td>
                        <td className="sw-num"><Figure minor={l.debitMinor} currency={s.currency} /></td>
                        <td className="sw-num"><Figure minor={l.creditMinor} currency={s.currency} /></td>
                        <td className="sw-sub">{l.memo}</td>
                      </tr>
                    ))}
                  </tbody>
                ))}
                <tfoot>
                  <tr>
                    <th scope="row" colSpan={3} style={{ textAlign: "end" }}>Schedule totals</th>
                    <td className="sw-num" data-testid="schedule-debit">
                      <Figure minor={s.totalDebitMinor} currency={s.currency} zero="zero" colour={false} />
                    </td>
                    <td className="sw-num" data-testid="schedule-credit">
                      <Figure minor={s.totalCreditMinor} currency={s.currency} zero="zero" colour={false} />
                    </td>
                    <td className="sw-sub">
                      {s.balanced
                        ? "Debits equal credits. Every elimination takes the same amount off both sides, so the group still balances after it."
                        : "This schedule does not balance, and it is not a journal until it does. Nothing has been plugged."}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
            {s.warnings.length > 0 && (
              <ul className="grid gap-2 px-3 py-2" style={{ borderTop: "1px solid var(--sw-line)" }}
                data-testid="schedule-warnings">
                {s.warnings.map((w, i) => (
                  <li key={i} className="sw-sub" style={{ color: "var(--sw-warn)" }}>{w}</li>
                ))}
              </ul>
            )}
          </Panel>

          {/* ---------------------------------------------- profit in stock */}

          <Panel className="overflow-hidden">
            <Head>Profit still sitting in stock</Head>
            <p className="sw-sub px-3 py-2">
              The ledger cannot know which stock came from where — inventory is fungible, and the same goods are
              bought from outside the group. So the quantities are typed in here, from a stock count, and the
              elimination is exactly as reliable as that count. The margin comes off; the cost stays.
            </p>
            <form className="flex flex-wrap items-end gap-2 px-3 pb-3" onSubmit={addStock}>
              <label className="flex flex-col gap-1">
                <span className="sw-label">Sold by</span>
                <select className="sw-select" style={{ width: "10rem" }} value={draft.seller} data-testid="stock-seller"
                  onChange={(e) => setDraft((v) => ({ ...v, seller: e.target.value }))}>
                  <option value="">Choose…</option>
                  {members.map((m) => <option key={m.entityId} value={m.entityId}>{m.legalName ?? m.entityId}</option>)}
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className="sw-label">Still held by</span>
                <select className="sw-select" style={{ width: "10rem" }} value={draft.holder} data-testid="stock-holder"
                  onChange={(e) => setDraft((v) => ({ ...v, holder: e.target.value }))}>
                  <option value="">Choose…</option>
                  {members.map((m) => <option key={m.entityId} value={m.entityId}>{m.legalName ?? m.entityId}</option>)}
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className="sw-label">Units</span>
                <input className="sw-input sw-num" style={{ width: "6rem" }} inputMode="numeric" value={draft.quantity}
                  onChange={(e) => setDraft((v) => ({ ...v, quantity: e.target.value }))} />
              </label>
              <label className="flex flex-col gap-1">
                <span className="sw-label">Transfer price, minor</span>
                <input className="sw-input sw-num" style={{ width: "9rem" }} inputMode="numeric" value={draft.price}
                  onChange={(e) => setDraft((v) => ({ ...v, price: e.target.value }))} />
              </label>
              <label className="flex flex-col gap-1">
                <span className="sw-label">Unit cost, minor</span>
                <input className="sw-input sw-num" style={{ width: "9rem" }} inputMode="numeric" value={draft.cost}
                  placeholder="optional"
                  onChange={(e) => setDraft((v) => ({ ...v, cost: e.target.value }))} />
              </label>
              <button type="submit" className="sw-btn" data-testid="stock-add">Add stock line</button>
              {stock.length > 0 && (
                <button type="button" className="sw-btn" onClick={() => { setStock([]); setMsg("Stock lines cleared."); }}>
                  Clear all
                </button>
              )}
            </form>

            {u && u.rows.length > 0 && (
              <>
                <div className="sw-scroll">
                  <table className="sw-table">
                    <caption className="sr-only">Stock bought within the group and still held</caption>
                    <thead>
                      <tr>
                        <th style={{ width: "9rem" }}>Sold by</th>
                        <th style={{ width: "9rem" }}>Held by</th>
                        <th style={{ minWidth: "9rem" }}>Item</th>
                        <th className="sw-num" style={{ width: "5rem" }}>Units</th>
                        <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Carried at</th>
                        <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Cost to group</th>
                        <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Unrealised</th>
                        <th style={{ minWidth: "16rem" }}>Where the cost came from</th>
                      </tr>
                    </thead>
                    <tbody>
                      {u.rows.map((row, i) => (
                        <tr key={i} data-testid="stock-row">
                          <td className="sw-code">{row.sellerEntityId}</td>
                          <td className="sw-code">{row.holderEntityId}</td>
                          <td>{row.item}</td>
                          <td className="sw-num">{row.quantity}</td>
                          <td className="sw-num"><Figure minor={row.carryingAmountMinor} currency={r.currency} /></td>
                          <td className="sw-num"><Figure minor={row.costToGroupMinor} currency={r.currency} /></td>
                          <td className="sw-num"><Figure minor={row.unrealisedProfitMinor} currency={r.currency} /></td>
                          <td className="sw-sub">{row.basisNote}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <th scope="row" colSpan={4} style={{ textAlign: "end" }}>Totals</th>
                        <td className="sw-num" data-testid="stock-carrying">
                          <Figure minor={u.totalCarryingMinor} currency={r.currency} zero="zero" colour={false} />
                        </td>
                        <td className="sw-num">
                          <Figure minor={u.totalCostMinor} currency={r.currency} zero="zero" colour={false} />
                        </td>
                        <td className="sw-num" data-testid="stock-unrealised">
                          <Figure minor={u.totalUnrealisedProfitMinor} currency={r.currency} zero="zero" colour={false} />
                        </td>
                        <td className="sw-sub">
                          Only the unrealised column is eliminated. The cost is a real cost and stays where it is.
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
                <p className="sw-sub px-3 py-2" style={{ borderTop: "1px solid var(--sw-line)" }}
                  role="status" aria-live="polite" data-testid="stock-note">
                  {u.inputNote}
                </p>
                {u.warnings.map((w, i) => (
                  <p key={i} className="sw-sub px-3 pb-2" style={{ color: "var(--sw-warn)" }}>{w}</p>
                ))}
              </>
            )}
            {(!u || u.rows.length === 0) && (
              <p className="sw-sub px-3 pb-3" data-testid="no-stock">
                No stock lines yet. Nothing is assumed in their absence: an elimination of nil is being reported
                because nobody has said there is any intragroup stock, not because the ledger has checked.
              </p>
            )}
          </Panel>
        </div>
      )}
    </>
  );
}

function Head({ children }: { children: React.ReactNode }) {
  return (
    <div className="border-b px-3 py-2" style={{ borderColor: "var(--sw-line)", background: "var(--sw-surface-2)" }}>
      <span className="sw-label">{children}</span>
    </div>
  );
}

function Measure({
  label, minor, currency, note,
}: { label: string; minor: string; currency: string; note: string }) {
  return (
    <tr data-testid="measure-row">
      <th scope="row">{label}</th>
      <td className="sw-num"><Figure minor={minor} currency={currency} zero="zero" /></td>
      <td className="sw-sub">{note}</td>
    </tr>
  );
}
