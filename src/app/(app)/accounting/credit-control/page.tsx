"use client";

import * as React from "react";
import { api, ApiError, useEntityId, useLedgerQuery } from "@/components/ledger/use-ledger";
import { Figure, PageHead, Panel, ErrorNote, Loading, Empty } from "@/components/ledger/primitives";
import { parseAmount } from "@/lib/ledger/format";

/* ------------------------------------------------------------------- shapes */

interface LimitInForce {
  limitMinor: string | null;
  limitSet: boolean;
  effectiveFrom: string | null;
  basis: string | null;
  setBy: string | null;
  source: "assessment" | "customer record" | "none";
  recordMinor: string | null;
  recordAgrees: boolean;
}

interface Reason { code: string; blocking: boolean; message: string }

interface OpenItem {
  documentId: string;
  number: string;
  reference: string;
  description: string;
  date: string;
  dueDate: string;
  outstandingMinor: string;
  daysOld: number;
  daysOverdue: number;
}

interface RegisterRow {
  code: string;
  name: string;
  email: string | null;
  currency: string;
  paymentTerms: number;
  status: string;
  limit: LimitInForce;
  exposure: {
    ledgerMinor: string;
    committedMinor: string;
    totalMinor: string;
    pastDueMinor: string;
    oldestPastDueDays: number | null;
    itemCount: number;
    orderCount: number;
    excludedForeignOrders: { number: string; currency: string; remainingGrossMinor: string }[];
  };
  headroomMinor: string | null;
  usedBps: number | null;
  overLimitMinor: string | null;
  onHold: boolean;
  hold: { placedOn: string; placedBy: string | null; reason: string } | null;
  lastNotice: { stage: string; sentOn: string; sentTo: string; daysAgo: number } | null;
  decision: "allow" | "review" | "refuse";
  reasons: Reason[];
  stageDue: string | null;
}

interface Register {
  asOf: string;
  currency: string;
  pastDueDays: number | null;
  customers: RegisterRow[];
  summary: {
    count: number; onHold: number; overLimit: number; unassessed: number;
    exposureMinor: string; committedMinor: string; pastDueMinor: string; limitMinor: string;
  };
  note: string;
}

interface Statement {
  code: string; name: string; currency: string; from: string | null; asOf: string;
  openingMinor: string; invoicedMinor: string; receivedMinor: string; creditedMinor: string;
  closingMinor: string; foots: boolean;
  items: OpenItem[];
  unallocated: OpenItem[];
  unallocatedMinor: string;
  bands: { notYetDue: string; d1_30: string; d31_60: string; d61_90: string; over90: string };
  bandsTotalMinor: string;
  totalMinor: string;
  ageingShareMinor: string;
  agrees: boolean;
  note: string;
}

interface Letter {
  code: string; name: string; stage: string; to: string | null;
  subject: string; body: string;
  pastDueMinor: string; oldestPastDueDays: number; itemCount: number; note: string;
}

interface History {
  code: string; name: string; currency: string;
  limits: { id: string; limitMinor: string; effectiveFrom: string; basis: string; setBy: string | null }[];
  holds: {
    id: string; placedOn: string; placedBy: string | null; reason: string;
    releasedOn: string | null; releasedBy: string | null; releaseReason: string | null;
    inForce: boolean; heldDays: number;
  }[];
  notices: {
    id: string; stage: string; sentOn: string; sentTo: string;
    overdueMinor: string; oldestDays: number; itemCount: number; recordedBy: string | null; letter: string;
  }[];
}

interface Check {
  decision: "allow" | "review" | "refuse";
  allowed: boolean;
  wouldBeMinor: string;
  overByMinor: string | null;
  headroomMinor: string | null;
  reasons: Reason[];
  summary: string;
}

/* ------------------------------------------------------------------- pieces */

const today = () => new Date().toISOString().slice(0, 10);

const DECISION_TONE: Record<string, string> = { allow: "sw-chip-ok", review: "sw-chip-warn", refuse: "sw-chip-bad" };
const DECISION_WORD: Record<string, string> = { allow: "within limit", review: "look at it", refuse: "stop" };

const STAGE_WORD: Record<string, string> = {
  reminder: "reminder", first: "first request", second: "second request", final: "final request",
};

function Decision({ decision }: { decision: string }) {
  return <span className={`sw-chip ${DECISION_TONE[decision] ?? ""}`}>{DECISION_WORD[decision] ?? decision}</span>;
}

/**
 * Basis points as a percentage, to one place, and nothing where no limit
 * exists. A customer holding a credit balance uses a negative share of their
 * limit, and that is written in parentheses like every other negative on the
 * page — a minus sign in a column of figures is the one thing a photocopier
 * loses.
 */
function used(bps: number | null): string {
  if (bps === null) return "–";
  const body = `${(Math.abs(bps) / 100).toFixed(1)}%`;
  return bps < 0 ? `(${body})` : body;
}

/* --------------------------------------------------------------------- page */

export default function CreditControlPage() {
  const entityId = useEntityId();
  const [asOf, setAsOf] = React.useState(today);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [tab, setTab] = React.useState<"standing" | "statement" | "letter" | "history">("standing");
  const [busy, setBusy] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [err, setErr] = React.useState<string | null>(null);

  const register = useLedgerQuery<Register>(
    entityId ? `/api/ledger/credit-control?entityId=${entityId}&asOf=${asOf}` : null,
    [asOf],
  );

  const act = async (label: string, body: Record<string, unknown>) => {
    setBusy(label); setErr(null); setMsg(null);
    try {
      const r = await api<Record<string, unknown>>("/api/ledger/credit-control", {
        method: "POST", body: JSON.stringify({ entityId, ...body }),
      });
      register.reload();
      return r;
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "That did not work.");
      return null;
    } finally {
      setBusy(null);
    }
  };

  if (!entityId) return <Loading label="Choosing an entity…" />;

  const rows = register.data?.customers ?? [];
  const row = rows.find((r) => r.code === selected) ?? null;

  return (
    <>
      <PageHead
        title="Credit control"
        sub={
          "What each customer is allowed to owe, what they owe now, and what is being done about the ones who are " +
          "late. Exposure is worked out from the receivables control account and from orders accepted but not yet " +
          "invoiced, every time it is asked for — never from a stored total, which is wrong the first time somebody " +
          "posts a journal by hand."
        }
        actions={
          <label className="flex items-center gap-1.5">
            <span className="sw-label">As at</span>
            <input type="date" className="sw-input" style={{ width: "9.5rem" }} value={asOf}
              onChange={(e) => { setAsOf(e.target.value); }} aria-label="Date to assess credit at" />
          </label>
        }
      />

      {err && <ErrorNote>{err}</ErrorNote>}
      {msg && <div className="sw-note mb-3" role="status" data-testid="credit-result">{msg}</div>}
      {register.error && <ErrorNote>{register.error}</ErrorNote>}
      {register.loading && !register.data && <Loading />}

      {register.data && (
        <Panel className="mb-4 p-4">
          <dl className="grid gap-4 sm:grid-cols-3 lg:grid-cols-5">
            <div>
              <dt className="sw-label">Exposure</dt>
              <dd className="sw-num mt-1 text-lg" data-testid="summary-exposure">
                <Figure minor={register.data.summary.exposureMinor} currency={register.data.currency} colour={false} />
              </dd>
              <p className="sw-sub mt-0.5">
                Of which <Figure minor={register.data.summary.committedMinor} currency={register.data.currency} colour={false} />{" "}
                is accepted orders no invoice has reached yet.
              </p>
            </div>
            <div>
              <dt className="sw-label">Past due</dt>
              <dd className="sw-num mt-1 text-lg" data-testid="summary-pastdue">
                <Figure minor={register.data.summary.pastDueMinor} currency={register.data.currency} colour={false} />
              </dd>
            </div>
            <div>
              <dt className="sw-label">Limits in force</dt>
              <dd className="sw-num mt-1 text-lg">
                <Figure minor={register.data.summary.limitMinor} currency={register.data.currency} colour={false} />
              </dd>
              <p className="sw-sub mt-0.5">The limits that exist, not a total that assumes the rest are nil.</p>
            </div>
            <div>
              <dt className="sw-label">On hold</dt>
              <dd className="sw-num mt-1 text-lg" data-testid="summary-onhold">{register.data.summary.onHold}</dd>
              <p className="sw-sub mt-0.5">{register.data.summary.overLimit} over their limit.</p>
            </div>
            <div>
              <dt className="sw-label">Never assessed</dt>
              <dd className="sw-num mt-1 text-lg" data-testid="summary-unassessed">{register.data.summary.unassessed}</dd>
              <p className="sw-sub mt-0.5">
                No limit has been set for these. That is not a limit of nothing — nobody has looked.
              </p>
            </div>
          </dl>
        </Panel>
      )}

      {register.data && rows.length === 0 && (
        <Empty>No customers in this entity yet, so there is nothing to set a limit against.</Empty>
      )}

      {rows.length > 0 && (
        <Panel className="mb-4 overflow-hidden">
          <div className="sw-scroll">
            <table className="sw-table">
              <caption className="sr-only">Every customer and where they stand as at {register.data?.asOf}</caption>
              <thead>
                <tr>
                  <th style={{ width: "7rem" }}>Code</th>
                  <th>Customer</th>
                  <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Limit</th>
                  <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>On the ledger</th>
                  <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Committed</th>
                  <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Exposure</th>
                  <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Headroom</th>
                  <th className="sw-num" style={{ width: "4.5rem" }}>Used</th>
                  <th className="sw-num" style={{ width: "5.5rem" }}>Oldest</th>
                  <th style={{ width: "8rem" }}>Standing</th>
                  <th style={{ width: "5rem" }}><span className="sr-only">Open</span></th>
                </tr>
              </thead>
              <tbody data-testid="credit-rows">
                {rows.map((r) => (
                  <tr key={r.code} data-testid={`credit-${r.code}`}>
                    <td className="sw-code">{r.code}</td>
                    <td className="max-w-0 truncate">
                      {r.name}
                      {r.onHold && <span className="sw-chip sw-chip-bad ml-1.5">on hold</span>}
                      {!r.limit.recordAgrees && <span className="sw-chip sw-chip-warn ml-1.5">record differs</span>}
                    </td>
                    <td className="sw-num">
                      {r.limit.limitSet
                        ? <Figure minor={r.limit.limitMinor} currency={r.currency} zero="zero" colour={false} />
                        : <span className="sw-sub">not assessed</span>}
                    </td>
                    <td className="sw-num"><Figure minor={r.exposure.ledgerMinor} currency={r.currency} colour={false} /></td>
                    <td className="sw-num"><Figure minor={r.exposure.committedMinor} currency={r.currency} colour={false} /></td>
                    <td className="sw-num"><Figure minor={r.exposure.totalMinor} currency={r.currency} colour={false} /></td>
                    {/* The sign carries the meaning here: below nought is over the limit. */}
                    <td className="sw-num">
                      {r.headroomMinor === null
                        ? <span className="sw-sub">–</span>
                        : <Figure minor={r.headroomMinor} currency={r.currency} />}
                    </td>
                    <td className="sw-num">{used(r.usedBps)}</td>
                    <td className="sw-num">
                      {r.exposure.oldestPastDueDays === null ? <span className="sw-zero">–</span> : r.exposure.oldestPastDueDays}
                    </td>
                    <td>
                      <Decision decision={r.decision} />
                      {r.stageDue && <span className="sw-chip ml-1.5">{STAGE_WORD[r.stageDue] ?? r.stageDue}</span>}
                    </td>
                    <td>
                      <button type="button" className="sw-link-btn" aria-expanded={selected === r.code}
                        data-testid={`open-${r.code}`}
                        onClick={() => { setSelected(selected === r.code ? null : r.code); setTab("standing"); setMsg(null); setErr(null); }}>
                        {selected === r.code ? "close" : "open"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      {row && entityId && (
        <>
          <div className="sw-tabs mb-3">
            {(["standing", "statement", "letter", "history"] as const).map((t) => (
              <button key={t} type="button" className="sw-tab" aria-current={tab === t ? "page" : undefined}
                data-testid={`tab-${t}`} onClick={() => setTab(t)}>
                {t === "standing" ? "Standing and limit" : t === "statement" ? "Statement of account"
                  : t === "letter" ? "Dunning" : "What was decided"}
              </button>
            ))}
          </div>

          {tab === "standing" && (
            <Standing
              key={row.code}
              row={row} asOf={asOf} entityId={entityId} busy={busy}
              onSetLimit={async (limitMinor, effectiveFrom, basis) => {
                const r = await act("limit", { action: "setLimit", partyKey: row.code, limitMinor, effectiveFrom, basis });
                if (r) setMsg(String(r.note));
              }}
              onHold={async (reason) => {
                const r = await act("hold", { action: "hold", partyKey: row.code, reason, on: asOf });
                if (r) setMsg(String(r.note));
              }}
              onRelease={async (reason) => {
                const r = await act("release", { action: "release", partyKey: row.code, reason, on: asOf });
                if (r) setMsg(String(r.note));
              }}
            />
          )}

          {tab === "statement" && <StatementPanel key={row.code} entityId={entityId} code={row.code} asOf={asOf} />}

          {tab === "letter" && (
            <LetterPanel
              key={row.code}
              entityId={entityId} row={row} asOf={asOf} busy={busy}
              onRecord={async (stage, sentTo) => {
                const r = await act("dunning", { action: "recordDunning", partyKey: row.code, stage, sentTo, sentOn: asOf });
                if (r) setMsg(String(r.note));
              }}
            />
          )}

          {tab === "history" && <HistoryPanel key={row.code} entityId={entityId} code={row.code} />}
        </>
      )}

      {register.data && (
        <p className="sw-sub mt-4 max-w-[75ch]">{register.data.note}</p>
      )}
    </>
  );
}

/* --------------------------------------------------------- standing and limit */

function Standing({ row, asOf, entityId, busy, onSetLimit, onHold, onRelease }: {
  row: RegisterRow;
  asOf: string;
  entityId: string;
  busy: string | null;
  onSetLimit: (limitMinor: string, effectiveFrom: string, basis: string) => void;
  onHold: (reason: string) => void;
  onRelease: (reason: string) => void;
}) {
  const [amount, setAmount] = React.useState("");
  const [check, setCheck] = React.useState<Check | null>(null);
  const [checking, setChecking] = React.useState(false);
  const [checkErr, setCheckErr] = React.useState<string | null>(null);

  const [limit, setLimit] = React.useState("");
  const [from, setFrom] = React.useState(asOf);
  const [basis, setBasis] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [formErr, setFormErr] = React.useState<string | null>(null);

  return (
    <>
      <Panel className="mb-4 p-4">
        <div className="sw-label">Would this sale go through?</div>
        <p className="sw-sub mt-1 max-w-[75ch]">
          A question, not an act. It reads the ledger and answers; nothing is recorded by asking. Every reason comes
          back separately, because &ldquo;refused&rdquo; on its own sends the salesperson to accounts and accounts
          back to the salesperson.
        </p>
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <label className="block">
            <span className="sw-label">Amount of the order or invoice</span>
            <input className="sw-input sw-num mt-1" style={{ width: "12rem" }} value={amount} placeholder="0.00"
              onChange={(e) => setAmount(e.target.value)} aria-label="Amount to check against the credit limit" />
          </label>
          <button type="button" className="sw-btn sw-btn-primary" disabled={checking} data-testid="run-check"
            onClick={async () => {
              const parsed = parseAmount(amount, row.currency);
              if (parsed === null || parsed < 0n) { setCheckErr("That is not an amount I can read."); setCheck(null); return; }
              setChecking(true); setCheckErr(null);
              try {
                setCheck(await api<Check>(
                  `/api/ledger/credit-control?entityId=${entityId}&view=check&partyKey=${encodeURIComponent(row.code)}` +
                  `&asOf=${asOf}&additionalMinor=${parsed.toString()}`,
                ));
              } catch (e) {
                setCheckErr(e instanceof ApiError ? e.message : "That did not work.");
                setCheck(null);
              } finally {
                setChecking(false);
              }
            }}>
            {checking ? "Checking…" : "Check it"}
          </button>
        </div>
        {checkErr && <div className="sw-error mt-2" role="alert">{checkErr}</div>}
        {check && (
          <div className="mt-3" data-testid="check-result">
            <div className="flex flex-wrap items-center gap-2">
              <Decision decision={check.decision} />
              <span className="sw-num">
                Would owe <Figure minor={check.wouldBeMinor} currency={row.currency} colour={false} />
              </span>
              {check.overByMinor && check.overByMinor !== "0" && (
                <span className="sw-num sw-num-neg">
                  over by <Figure minor={check.overByMinor} currency={row.currency} colour={false} />
                </span>
              )}
            </div>
            {check.reasons.length === 0 ? (
              <p className="sw-sub mt-2 max-w-[75ch]">{check.summary}</p>
            ) : (
              <ul className="mt-2 max-w-[75ch]">
                {check.reasons.map((r) => (
                  <li key={r.code} className="sw-sub mt-1">
                    <span className={`sw-chip ${r.blocking ? "sw-chip-bad" : "sw-chip-warn"} mr-1.5`}>
                      {r.blocking ? "stops it" : "worth knowing"}
                    </span>
                    {r.message}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </Panel>

      <div className="mb-4 grid gap-4 lg:grid-cols-2">
        <Panel className="p-4">
          <div className="sw-label">The limit in force</div>
          {row.limit.limitSet ? (
            <p className="sw-sub mt-1 max-w-[62ch]">
              <span className="sw-num">
                <Figure minor={row.limit.limitMinor} currency={row.currency} zero="zero" colour={false} />
              </span>
              {row.limit.effectiveFrom ? ` from ${row.limit.effectiveFrom}. ` : ` — ${row.limit.source}. `}
              {row.limit.basis}
              {!row.limit.recordAgrees && (
                <> The customer record carries a different figure, which means it was edited outside credit control.
                  The assessments are the ones with dates, so they are what this screen reads.</>
              )}
            </p>
          ) : (
            <p className="sw-sub mt-1 max-w-[62ch]">
              Nobody has assessed this account. That is not a limit of nothing: a limit of nothing is a decision that
              they pay up front, and this is the absence of a decision. Sales are not stopped by it — they are
              flagged — because refusing every unassessed customer only teaches people to type a limit in to clear
              the block.
            </p>
          )}

          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <label className="block">
              <span className="sw-label">New limit</span>
              <input className="sw-input sw-num mt-1" value={limit} placeholder="0.00"
                onChange={(e) => setLimit(e.target.value)} aria-label="New credit limit" />
            </label>
            <label className="block">
              <span className="sw-label">In force from</span>
              <input type="date" className="sw-input mt-1" value={from}
                onChange={(e) => setFrom(e.target.value)} aria-label="Date the new limit takes effect" />
            </label>
          </div>
          <label className="mt-2 block">
            <span className="sw-label">How it was arrived at</span>
            <input className="sw-input mt-1" style={{ width: "100%" }} value={basis}
              onChange={(e) => setBasis(e.target.value)}
              placeholder="Two years of trade, no arrears, references taken"
              aria-label="Why this limit" />
          </label>
          <button type="button" className="sw-btn mt-2" disabled={busy === "limit"} data-testid="save-limit"
            onClick={() => {
              const parsed = parseAmount(limit, row.currency);
              if (parsed === null || parsed < 0n) { setFormErr("A limit is an amount of nought or more."); return; }
              if (!basis.trim()) { setFormErr("Say how the limit was arrived at — it is the whole of a credit file."); return; }
              setFormErr(null);
              onSetLimit(parsed.toString(), from, basis.trim());
              setLimit(""); setBasis("");
            }}>
            {busy === "limit" ? "Recording…" : "Record the assessment"}
          </button>
          <p className="sw-sub mt-2 max-w-[62ch]">
            Each assessment is kept with its date. Raising a limit today does not make last quarter&rsquo;s breach
            acceptable, so the check reads the limit that was in force on the day it is asked about.
          </p>
        </Panel>

        <Panel className="p-4">
          <div className="sw-label">{row.onHold ? "This account is on hold" : "Hold this account"}</div>
          {row.hold && (
            <p className="sw-sub mt-1 max-w-[62ch]">
              Held since {row.hold.placedOn}
              {row.hold.placedBy ? ` by ${row.hold.placedBy}` : ""}: {row.hold.reason}
            </p>
          )}
          {!row.onHold && (
            <p className="sw-sub mt-1 max-w-[62ch]">
              A hold stops the next order; it changes nothing they already owe and posts nothing. It needs a reason,
              because whoever is asked to lift it next week has only that sentence to weigh.
            </p>
          )}
          <label className="mt-3 block">
            <span className="sw-label">{row.onHold ? "Why it is being lifted" : "Why"}</span>
            <input className="sw-input mt-1" style={{ width: "100%" }} value={reason}
              onChange={(e) => setReason(e.target.value)}
              aria-label={row.onHold ? "Why the hold is being released" : "Why the account is being held"} />
          </label>
          <button type="button" className="sw-btn mt-2" data-testid={row.onHold ? "release-hold" : "place-hold"}
            disabled={busy === "hold" || busy === "release"}
            onClick={() => {
              if (!reason.trim()) { setFormErr("A hold, and a release, each need a reason on the record."); return; }
              setFormErr(null);
              if (row.onHold) onRelease(reason.trim()); else onHold(reason.trim());
              setReason("");
            }}>
            {row.onHold ? "Release the hold" : "Place the account on hold"}
          </button>
          <p className="sw-sub mt-2 max-w-[62ch]">
            Releasing records the release. The hold is not deleted — the question anybody asks about a re-held
            account is what happened the last two times.
          </p>
        </Panel>
      </div>

      {formErr && <ErrorNote>{formErr}</ErrorNote>}

      {row.exposure.excludedForeignOrders.length > 0 && (
        <Panel className="mb-4 p-4">
          <div className="sw-label">Left out of the exposure</div>
          <p className="sw-sub mt-1 max-w-[75ch]">
            These orders are in another currency, and converting them would need a rate nobody has stated. A made-up
            rate inside a credit limit is a made-up limit, so they are shown rather than added.
          </p>
          <ul className="mt-2">
            {row.exposure.excludedForeignOrders.map((o) => (
              <li key={o.number} className="sw-sub">
                {o.number} — <span className="sw-num"><Figure minor={o.remainingGrossMinor} currency={o.currency} colour={false} /></span> {o.currency}
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </>
  );
}

/* ------------------------------------------------------------- the statement */

function StatementPanel({ entityId, code, asOf }: { entityId: string; code: string; asOf: string }) {
  const [from, setFrom] = React.useState("");
  const { data, error, loading } = useLedgerQuery<Statement>(
    `/api/ledger/credit-control?entityId=${entityId}&view=statement&partyKey=${encodeURIComponent(code)}` +
      `&asOf=${asOf}${from ? `&from=${from}` : ""}`,
    [code, asOf, from],
  );

  return (
    <>
      <Panel className="mb-4 p-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="sw-label">Statement of account</div>
            <p className="sw-sub mt-1 max-w-[75ch]">
              Every open item as at the date, banded by how far past due it is rather than by how old the document
              is. A forty-five-day-old invoice on sixty-day terms is not late, and putting it beside money that is
              invites an argument about the wrong figure.
            </p>
          </div>
          <label className="flex items-center gap-1.5">
            <span className="sw-label">From</span>
            <input type="date" className="sw-input" style={{ width: "9.5rem" }} value={from}
              onChange={(e) => setFrom(e.target.value)} aria-label="Date the statement runs from" />
          </label>
        </div>
      </Panel>

      {error && <ErrorNote>{error}</ErrorNote>}
      {loading && !data && <Loading />}

      {data && (
        <>
          <Panel className="mb-4 overflow-hidden">
            <div className="sw-scroll">
              <table className="sw-table">
                <caption className="sr-only">How the balance moved between {data.from ?? "the beginning"} and {data.asOf}</caption>
                <thead>
                  <tr>
                    <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Opening</th>
                    <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Invoiced</th>
                    <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Received</th>
                    <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Credited</th>
                    <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Closing</th>
                    <th>It adds up</th>
                  </tr>
                </thead>
                <tbody>
                  <tr data-testid="statement-foot">
                    <td className="sw-num"><Figure minor={data.openingMinor} currency={data.currency} zero="zero" colour={false} /></td>
                    <td className="sw-num"><Figure minor={data.invoicedMinor} currency={data.currency} zero="zero" colour={false} /></td>
                    <td className="sw-num"><Figure minor={data.receivedMinor} currency={data.currency} zero="zero" colour={false} /></td>
                    <td className="sw-num"><Figure minor={data.creditedMinor} currency={data.currency} zero="zero" colour={false} /></td>
                    {/* Below nought means the business is holding the customer's money. */}
                    <td className="sw-num"><Figure minor={data.closingMinor} currency={data.currency} zero="zero" /></td>
                    <td>
                      <span className={`sw-chip ${data.foots && data.agrees ? "sw-chip-ok" : "sw-chip-bad"}`}>
                        {data.foots ? (data.agrees ? "ties to 1100" : "does not tie") : "does not foot"}
                      </span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="sw-sub p-3 pt-2 max-w-[80ch]">{data.note}</p>
          </Panel>

          <Panel className="mb-4 overflow-hidden">
            <div className="sw-scroll">
              <table className="sw-table">
                <caption className="sr-only">The open items banded by how far past due they are</caption>
                <thead>
                  <tr>
                    <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Not yet due</th>
                    <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>1–30 days</th>
                    <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>31–60</th>
                    <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>61–90</th>
                    <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Over 90</th>
                    <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Unapplied</th>
                    <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Total</th>
                  </tr>
                </thead>
                <tbody>
                  <tr data-testid="statement-bands">
                    <td className="sw-num"><Figure minor={data.bands.notYetDue} currency={data.currency} colour={false} /></td>
                    <td className="sw-num"><Figure minor={data.bands.d1_30} currency={data.currency} colour={false} /></td>
                    <td className="sw-num"><Figure minor={data.bands.d31_60} currency={data.currency} colour={false} /></td>
                    <td className="sw-num"><Figure minor={data.bands.d61_90} currency={data.currency} colour={false} /></td>
                    <td className="sw-num"><Figure minor={data.bands.over90} currency={data.currency} colour={false} /></td>
                    <td className="sw-num"><Figure minor={data.unallocatedMinor} currency={data.currency} /></td>
                    <td className="sw-num"><Figure minor={data.totalMinor} currency={data.currency} zero="zero" /></td>
                  </tr>
                </tbody>
              </table>
            </div>
          </Panel>

          {data.items.length === 0 && data.unallocated.length === 0 ? (
            <Empty>Nothing is outstanding on this account at {data.asOf}.</Empty>
          ) : (
            <Panel className="mb-4 overflow-hidden">
              <div className="sw-scroll">
                <table className="sw-table">
                  <caption className="sr-only">Every open item on the account at {data.asOf}</caption>
                  <thead>
                    <tr>
                      <th style={{ width: "9rem" }}>Document</th>
                      <th>What it was for</th>
                      <th style={{ width: "7rem" }}>Raised</th>
                      <th style={{ width: "7rem" }}>Due</th>
                      <th className="sw-num" style={{ width: "5.5rem" }}>Past due</th>
                      <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Outstanding</th>
                    </tr>
                  </thead>
                  <tbody data-testid="statement-items">
                    {[...data.items, ...data.unallocated].map((i) => (
                      <tr key={i.documentId}>
                        <td className="sw-code">{i.number}</td>
                        <td className="max-w-0 truncate">{i.description}</td>
                        <td>{i.date}</td>
                        <td>{i.dueDate}</td>
                        <td className="sw-num">{i.daysOverdue === 0 ? <span className="sw-zero">–</span> : i.daysOverdue}</td>
                        <td className="sw-num"><Figure minor={i.outstandingMinor} currency={data.currency} /></td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colSpan={5}>Total, which is the closing balance</td>
                      <td className="sw-num"><Figure minor={data.totalMinor} currency={data.currency} zero="zero" /></td>
                    </tr>
                  </tfoot>
                </table>
              </div>
              {data.unallocated.length > 0 && (
                <p className="sw-sub p-3 pt-2 max-w-[80ch]">
                  The rows in the customer&rsquo;s favour are money held against no invoice — an unapplied receipt or
                  a credit note nobody has set against anything. They are not aged, because nobody is late paying
                  money the business owes.
                </p>
              )}
            </Panel>
          )}
        </>
      )}
    </>
  );
}

/* ---------------------------------------------------------------- the letter */

function LetterPanel({ entityId, row, asOf, busy, onRecord }: {
  entityId: string;
  row: RegisterRow;
  asOf: string;
  busy: string | null;
  onRecord: (stage: string, sentTo: string) => void;
}) {
  const [stage, setStage] = React.useState<string>(row.stageDue ?? "reminder");
  const [sentTo, setSentTo] = React.useState(row.email ?? "");
  const { data, error, loading } = useLedgerQuery<Letter>(
    `/api/ledger/credit-control?entityId=${entityId}&view=letter&partyKey=${encodeURIComponent(row.code)}` +
      `&asOf=${asOf}&stage=${stage}`,
    [row.code, asOf, stage],
  );

  return (
    <>
      <Panel className="mb-4 p-4">
        <div className="sw-label">The next letter</div>
        <p className="sw-sub mt-1 max-w-[75ch]">
          The ladder climbs by how far past due the oldest item is, and it never repeats a rung: a customer who has
          had the first request gets the second, because sending the same letter again teaches them that none of them
          mean anything. Nothing here is sent — there is no mail transport in this product. Copy the text into
          whatever the business sends from, then record that it went.
        </p>
        {row.lastNotice && (
          <p className="sw-sub mt-2 max-w-[75ch]" data-testid="last-notice">
            Last sent: the {STAGE_WORD[row.lastNotice.stage] ?? row.lastNotice.stage} on {row.lastNotice.sentOn} to{" "}
            {row.lastNotice.sentTo}, {row.lastNotice.daysAgo} day{row.lastNotice.daysAgo === 1 ? "" : "s"} ago.
          </p>
        )}
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <label className="block">
            <span className="sw-label">Which rung</span>
            <select className="sw-select mt-1" value={stage} onChange={(e) => setStage(e.target.value)}
              aria-label="Which rung of the dunning ladder">
              <option value="reminder">Reminder — from 7 days past due</option>
              <option value="first">First request — from 14 days</option>
              <option value="second">Second request — from 30 days</option>
              <option value="final">Final request — from 60 days</option>
            </select>
          </label>
          <label className="block">
            <span className="sw-label">Sent to</span>
            <input className="sw-input mt-1" style={{ width: "18rem" }} value={sentTo}
              onChange={(e) => setSentTo(e.target.value)} placeholder="ap@customer.example"
              aria-label="Address the letter was sent to" />
          </label>
          <button type="button" className="sw-btn sw-btn-primary" disabled={busy === "dunning" || !data}
            data-testid="record-dunning"
            onClick={() => onRecord(stage, sentTo.trim())}>
            {busy === "dunning" ? "Recording…" : "Record that it was sent"}
          </button>
        </div>
      </Panel>

      {error && <ErrorNote>{error}</ErrorNote>}
      {loading && !data && <Loading />}

      {data && (
        <Panel className="mb-4 p-4">
          <div className="sw-label">{data.subject}</div>
          <pre className="sw-sub mt-2 overflow-x-auto whitespace-pre-wrap" data-testid="letter-body"
            style={{ fontFamily: "var(--sw-font-mono)", color: "var(--sw-fg)" }}>
            {data.body}
          </pre>
          <p className="sw-sub mt-3 max-w-[80ch]">{data.note}</p>
        </Panel>
      )}
    </>
  );
}

/* --------------------------------------------------------------- the history */

function HistoryPanel({ entityId, code }: { entityId: string; code: string }) {
  const { data, error, loading } = useLedgerQuery<History>(
    `/api/ledger/credit-control?entityId=${entityId}&view=history&partyKey=${encodeURIComponent(code)}`,
    [code],
  );

  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (loading && !data) return <Loading />;
  if (!data) return null;

  return (
    <>
      <Panel className="mb-4 overflow-hidden">
        <div className="sw-scroll">
          <table className="sw-table">
            <caption className="sr-only">Every credit limit assessed for {data.name}</caption>
            <thead>
              <tr>
                <th style={{ width: "8rem" }}>In force from</th>
                <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Limit</th>
                <th>How it was arrived at</th>
                <th style={{ width: "9rem" }}>Set by</th>
              </tr>
            </thead>
            <tbody data-testid="limit-history">
              {data.limits.length === 0 ? (
                <tr><td colSpan={4} className="sw-sub">This account has never been assessed.</td></tr>
              ) : data.limits.map((l) => (
                <tr key={l.id}>
                  <td>{l.effectiveFrom}</td>
                  <td className="sw-num"><Figure minor={l.limitMinor} currency={data.currency} zero="zero" colour={false} /></td>
                  <td>{l.basis}</td>
                  <td className="sw-sub">{l.setBy ?? "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel className="mb-4 overflow-hidden">
        <div className="sw-scroll">
          <table className="sw-table">
            <caption className="sr-only">Every hold placed on {data.name}, and how each ended</caption>
            <thead>
              <tr>
                <th style={{ width: "7rem" }}>Held from</th>
                <th>Why</th>
                <th style={{ width: "7rem" }}>Released</th>
                <th>Why it was lifted</th>
                <th className="sw-num" style={{ width: "5rem" }}>Days</th>
              </tr>
            </thead>
            <tbody data-testid="hold-history">
              {data.holds.length === 0 ? (
                <tr><td colSpan={5} className="sw-sub">This account has never been held.</td></tr>
              ) : data.holds.map((h) => (
                <tr key={h.id}>
                  <td>{h.placedOn}{h.inForce && <span className="sw-chip sw-chip-bad ml-1.5">in force</span>}</td>
                  <td>{h.reason}</td>
                  <td>{h.releasedOn ?? <span className="sw-zero">–</span>}</td>
                  <td>{h.releaseReason ?? <span className="sw-zero">–</span>}</td>
                  <td className="sw-num">{h.heldDays}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel className="overflow-hidden">
        <div className="sw-scroll">
          <table className="sw-table">
            <caption className="sr-only">Every letter sent to {data.name}</caption>
            <thead>
              <tr>
                <th style={{ width: "7rem" }}>Sent</th>
                <th style={{ width: "9rem" }}>Which rung</th>
                <th>To</th>
                <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Past due then</th>
                <th className="sw-num" style={{ width: "5rem" }}>Oldest</th>
                <th className="sw-num" style={{ width: "5rem" }}>Items</th>
              </tr>
            </thead>
            <tbody data-testid="notice-history">
              {data.notices.length === 0 ? (
                <tr><td colSpan={6} className="sw-sub">Nothing has been sent to this customer.</td></tr>
              ) : data.notices.map((n) => (
                <tr key={n.id}>
                  <td>{n.sentOn}</td>
                  <td>{STAGE_WORD[n.stage] ?? n.stage}</td>
                  <td className="max-w-0 truncate">{n.sentTo}</td>
                  <td className="sw-num"><Figure minor={n.overdueMinor} currency={data.currency} colour={false} /></td>
                  <td className="sw-num">{n.oldestDays}</td>
                  <td className="sw-num">{n.itemCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="sw-sub p-3 pt-2 max-w-[80ch]">
          The text of each letter is kept with it, so an argument about what the customer was told is settled by
          reading what they were sent rather than by reconstructing what it probably said.
        </p>
      </Panel>
    </>
  );
}
