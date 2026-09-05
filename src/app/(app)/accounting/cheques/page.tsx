"use client";

import * as React from "react";
import Link from "next/link";
import { api, ApiError, useEntityId, useLedgerQuery } from "@/components/ledger/use-ledger";
import { Figure, PageHead, Panel, ErrorNote, Loading, Empty } from "@/components/ledger/primitives";
import { fmtMinor, parseAmount } from "@/lib/ledger/format";

/**
 * The cheque drawer.
 *
 * Two things shape this screen. Cheques received and cheques issued are
 * opposite obligations — one is money owed to the business, the other is money
 * the business has committed and must have in the bank on a stated day — so
 * they are never drawn as one list, however much shorter that would be. And
 * everything here is ordered by the day a cheque may be presented, not by the
 * day it was written, because that is the whole of what a post-dated cheque is.
 *
 * The three questions, in the order somebody actually asks them: does the
 * register agree with the ledger, what falls due next and can we meet it, and
 * where is each individual piece of paper.
 */

type ChequeStatus = "held" | "deposited" | "cleared" | "bounced" | "returned" | "cancelled";
type DueBucket = "overdue" | "d0_30" | "d31_60" | "d61_90" | "over90";
type Direction = "RECEIVED" | "ISSUED";

interface ChequeRow {
  id: string;
  direction: Direction;
  number: string;
  bankName: string | null;
  bankAccount: string;
  counterparty: string;
  counterpartyId: string | null;
  writtenOn: string;
  dueOn: string;
  amountMinor: string;
  currency: string;
  status: ChequeStatus;
  settlesId: string | null;
  statusOn: string | null;
  bounceReason: string | null;
  daysToDue: number;
  bucket: DueBucket;
  outstanding: boolean;
  bounceCount: number;
  heldEntryId: string | null;
  clearedEntryId: string | null;
  bouncedEntryId: string | null;
  accountCode: string;
}

interface DirectionRegister {
  direction: Direction;
  accountCode: string;
  held: ChequeRow[];
  deposited: ChequeRow[];
  cleared: ChequeRow[];
  bounced: ChequeRow[];
  closed: ChequeRow[];
  heldMinor: string;
  depositedMinor: string;
  outstandingMinor: string;
  clearedMinor: string;
  bouncedMinor: string;
  buckets: Record<DueBucket, string>;
  ledgerMinor: string;
  differenceMinor: string;
  reconciled: boolean;
  count: number;
}

interface DueSoonRow extends ChequeRow {
  cumulativeMinor: string;
  bankMinor: string;
  covered: boolean;
  shortfallMinor: string;
}

interface Diary {
  asOf: string;
  days: number;
  until: string;
  received: ChequeRow[];
  issued: DueSoonRow[];
  receivedMinor: string;
  issuedMinor: string;
  bankMinor: string;
  shortfallMinor: string;
  uncoveredCount: number;
  firstShortDay: string | null;
}

interface RegisterResponse {
  register: {
    asOf: string;
    received: DirectionRegister;
    issued: DirectionRegister;
    reconciled: boolean;
    outstandingMinor: string;
  };
  diary: Diary;
}

interface ChequeEvent {
  on: string;
  kind: string;
  detail: string | null;
  entryId: string | null;
  reference: string | null;
}

interface DetailResponse {
  cheque: ChequeRow;
  history: ChequeEvent[];
}

/** The same table the subledger enforces, so a blocked action says why here too. */
const ALLOWED: Record<ChequeStatus, ChequeStatus[]> = {
  held: ["deposited", "cleared", "bounced", "returned", "cancelled"],
  deposited: ["cleared", "bounced"],
  bounced: ["held", "returned", "cancelled"],
  cleared: [],
  returned: [],
  cancelled: [],
};

const SAYS: Record<ChequeStatus, string> = {
  held: "in hand",
  deposited: "with the bank",
  cleared: "cleared",
  bounced: "bounced",
  returned: "returned",
  cancelled: "cancelled",
};

const TONE: Record<ChequeStatus, string> = {
  held: "",
  deposited: "sw-chip-accent",
  cleared: "sw-chip-ok",
  bounced: "sw-chip-bad",
  returned: "sw-chip-warn",
  cancelled: "sw-chip-warn",
};

/** The same states said as acts, for a sentence about what can happen next. */
const ACT: Record<ChequeStatus, string> = {
  held: "presented again",
  deposited: "banked",
  cleared: "cleared",
  bounced: "marked bounced",
  returned: "handed back",
  cancelled: "cancelled",
};

/** One row of buttons, in the order a cheque usually travels. */
const STEPS: {
  to: ChequeStatus; action: string; label: string; primary?: boolean; said: (c: ChequeRow) => string;
}[] = [
  { to: "deposited", action: "deposit", label: "Banked it", said: (c) => `Cheque ${c.number} is with the bank.` },
  { to: "cleared", action: "clear", label: "It cleared", primary: true, said: (c) => `Cheque ${c.number} cleared.` },
  { to: "bounced", action: "bounce", label: "It bounced", said: (c) => `Cheque ${c.number} bounced; the debt is back where it was.` },
  { to: "held", action: "represent", label: "Present it again", said: (c) => `Cheque ${c.number} is in again.` },
  { to: "returned", action: "return", label: "Hand it back", said: (c) => `Cheque ${c.number} went back to ${c.counterparty}.` },
  { to: "cancelled", action: "cancel", label: "Cancel it", said: (c) => `Cheque ${c.number} is cancelled.` },
];

const BUCKETS: { key: DueBucket; label: string; hint: string }[] = [
  { key: "overdue", label: "Past due", hint: "date gone, not presented" },
  { key: "d0_30", label: "0–30 days", hint: "this month" },
  { key: "d31_60", label: "31–60", hint: "next month" },
  { key: "d61_90", label: "61–90", hint: "the month after" },
  { key: "over90", label: "90+", hint: "long dated" },
];

const today = () => new Date().toISOString().slice(0, 10);

/**
 * The currency the journal is written in. A cheque may be drawn in anything —
 * a supplier in Riyadh writes one in SAR — but the entry that records it is in
 * the book's own currency, so anything else has to arrive with a rate.
 *
 * The subledger says the same thing by comparing the cheque's currency against
 * this literal, which is why the screen can state it rather than read it: if
 * the book ever stops being kept in dirhams, `fxOf` in cheques.ts is the place
 * that changes and this follows it.
 */
const BOOK_CURRENCY = "AED";

/**
 * Which moves need a rate to the book's currency.
 *
 * Not "every move on a foreign cheque": banking a cheque raises no journal at
 * all — the paper went from a drawer to a counter — and handing back or
 * cancelling one that has already bounced raises none either, because the
 * bounce already put the debt back on the trade account. Demanding a rate for
 * a posting that will not happen is a gate that teaches the wrong rule.
 */
function needsRate(cheque: { currency: string; status: ChequeStatus }, to: ChequeStatus): boolean {
  if (cheque.currency.toUpperCase() === BOOK_CURRENCY) return false;
  if (to === "deposited") return false;
  if (cheque.status === "bounced" && (to === "returned" || to === "cancelled")) return false;
  return true;
}

/** A rate as typed, or null when it is not one the ledger can use. */
function parseRate(text: string): number | null {
  const t = text.trim();
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** A currency is a three-letter code. Anything else is a typo, not a currency. */
const isCurrencyCode = (raw: string) => /^[A-Z]{3}$/.test(raw.trim().toUpperCase());

export default function ChequesPage() {
  const entityId = useEntityId();
  const [asOf, setAsOf] = React.useState(today);
  const [days, setDays] = React.useState(30);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [recording, setRecording] = React.useState(false);

  const q = useLedgerQuery<RegisterResponse>(
    entityId ? `/api/ledger/cheques?entityId=${entityId}&asOf=${asOf}&days=${days}` : null,
    [asOf, days],
  );
  const detail = useLedgerQuery<DetailResponse>(
    entityId && selected ? `/api/ledger/cheques?entityId=${entityId}&chequeId=${encodeURIComponent(selected)}&asOf=${asOf}` : null,
    [selected, asOf],
  );

  const act = async (key: string, body: Record<string, unknown>) => {
    setBusy(key); setErr(null); setMsg(null);
    try {
      const r = await api<Record<string, unknown>>("/api/ledger/cheques", {
        method: "POST", body: JSON.stringify({ entityId, ...body }),
      });
      q.reload();
      if (selected) detail.reload();
      return r;
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "That did not work.");
      return null;
    } finally {
      setBusy(null);
    }
  };

  if (!entityId) return <Loading label="Choosing an entity…" />;

  const reg = q.data?.register;
  const diary = q.data?.diary;
  const nothing = reg && reg.received.count === 0 && reg.issued.count === 0;

  return (
    <>
      <PageHead
        title="Cheques"
        sub="Post-dated cheques, from the day the paper changes hands to the day the bank pays it. A cheque taken in is not cash and not an ordinary receivable either — it is a receivable whose form has changed, and it sits in its own account until it clears or bounces."
        actions={
          <>
            <label className="flex items-center gap-1.5">
              <span className="sw-label">As at</span>
              <input
                type="date"
                className="sw-input"
                style={{ width: "9.5rem" }}
                value={asOf}
                onChange={(e) => setAsOf(e.target.value || today())}
              />
            </label>
            <label className="flex items-center gap-1.5">
              <span className="sw-label">Diary</span>
              <select
                className="sw-select"
                style={{ width: "8.5rem" }}
                value={days}
                onChange={(e) => setDays(Number(e.target.value))}
              >
                <option value={7}>next 7 days</option>
                <option value={30}>next 30 days</option>
                <option value={60}>next 60 days</option>
                <option value={90}>next 90 days</option>
              </select>
            </label>
            <button type="button" className="sw-btn" onClick={() => setRecording((r) => !r)} data-testid="new-cheque">
              {recording ? "Cancel" : "Record a cheque"}
            </button>
          </>
        }
      />

      {err && <ErrorNote>{err}</ErrorNote>}
      {msg && <div className="sw-note mb-3" role="status" data-testid="cheque-result">{msg}</div>}
      {q.error && <ErrorNote>{q.error}</ErrorNote>}

      {recording && (
        <RecordCheque
          busy={busy === "record"}
          onRecord={async (cheque) => {
            const r = await act("record", { action: "record", ...cheque });
            if (r) {
              setRecording(false);
              setSelected(String(r.chequeId));
              setMsg(
                r.alreadyRecorded
                  ? `Cheque ${String(cheque.number)} was already in the register — nothing was posted a second time.`
                  : `Cheque ${String(cheque.number)} recorded and posted as ${String(r.reference)}. ` +
                    `It falls due on ${String(cheque.dueOn)}.`,
              );
            }
          }}
        />
      )}

      {q.loading && !q.data && <Loading />}
      {nothing && !recording && (
        <Empty>
          No cheques in the register yet. Record one above: which way it goes, the number on the paper, who wrote it or
          who it is written to, and the date it may be presented — that date is what everything here is ordered by.
        </Empty>
      )}

      {reg && !nothing && (
        <>
          <div className="mb-4 grid gap-4 lg:grid-cols-2">
            <Reconciliation
              title="Cheques received"
              sub="Customers' paper, held until it clears."
              register={reg.received}
              asOf={reg.asOf}
            />
            <Reconciliation
              title="Cheques issued"
              sub="Our own paper, committed and dated."
              register={reg.issued}
              asOf={reg.asOf}
            />
          </div>

          {diary && (
            <div className="mb-4 grid gap-4 lg:grid-cols-2">
              <ComingIn diary={diary} onOpen={setSelected} selected={selected} />
              <GoingOut diary={diary} onOpen={setSelected} selected={selected} />
            </div>
          )}

          <div className="grid gap-4 lg:grid-cols-2">
            <RegisterTable
              title="Received — the register"
              register={reg.received}
              onOpen={(id) => setSelected(id === selected ? null : id)}
              selected={selected}
            />
            <RegisterTable
              title="Issued — the register"
              register={reg.issued}
              onOpen={(id) => setSelected(id === selected ? null : id)}
              selected={selected}
            />
          </div>
        </>
      )}

      {selected && detail.error && <ErrorNote>{detail.error}</ErrorNote>}
      {selected && detail.data && (
        <ChequePanel
          detail={detail.data}
          busy={busy}
          onAct={async (action, body, said) => {
            const r = await act(`${detail.data!.cheque.id}:${action}`, { action, chequeId: detail.data!.cheque.id, ...body });
            if (r) setMsg(r.reference ? `${said} Posted as ${String(r.reference)}.` : said);
          }}
        />
      )}
    </>
  );
}

/* ------------------------------------------------------- the reconciliation */

/**
 * The register against the ledger, drawn as the subtraction it is.
 *
 * The two figures are computed from different places on purpose — one from the
 * cheques, one from the journal lines — so agreement means something. The chip
 * is never the only signal: the difference is shown as a figure beside it.
 */
function Reconciliation({ title, sub, register, asOf }: {
  title: string; sub: string; register: DirectionRegister; asOf: string;
}) {
  const currency = register.held[0]?.currency ?? register.deposited[0]?.currency ?? BOOK_CURRENCY;
  /*
   * Whether the outstanding total is a total of one currency.
   *
   * `chequeRegister` adds `amountMinor` across the paper it is a register of,
   * and a cheque keeps its own currency — so once a foreign cheque is in the
   * drawer, that total is dirhams and riyals added together, while the ledger
   * figure beside it is the entity's functional currency alone. The difference
   * between them is then a translation and not a fault, and the chip above
   * would be calling it one. Saying so is the only honest thing to draw here:
   * the register cannot be made to tie in a currency it does not carry.
   */
  const currencies = [...new Set(
    [...register.held, ...register.deposited].map((c) => c.currency.toUpperCase()),
  )];
  const mixed = currencies.length > 1 || (currencies.length === 1 && currencies[0] !== BOOK_CURRENCY);
  return (
    <Panel className="p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <div className="sw-label">{title}</div>
          <p className="sw-sub mt-0.5">{sub}</p>
        </div>
        <span
          className={`sw-chip ${mixed ? "sw-chip-warn" : register.reconciled ? "sw-chip-ok" : "sw-chip-bad"}`}
          data-testid={`chip-${register.direction}`}
        >
          {mixed ? "not comparable" : register.reconciled ? "ties to the ledger" : "does not tie"}
        </span>
      </div>

      <table className="sw-table mt-3" style={{ maxWidth: "32rem" }}>
        <caption className="sr-only">
          {title}: the register against account {register.accountCode} as at {asOf}
        </caption>
        <tbody>
          <tr>
            <th scope="row" style={{ fontWeight: 400 }}>In hand</th>
            <td className="sw-num" data-testid={`held-${register.direction}`}>
              <Figure minor={register.heldMinor} currency={currency} zero="zero" colour={false} />
            </td>
          </tr>
          <tr>
            <th scope="row" style={{ fontWeight: 400 }}>
              <span aria-hidden="true">+ </span>With the bank
            </th>
            <td className="sw-num">
              <Figure minor={register.depositedMinor} currency={currency} zero="zero" colour={false} />
            </td>
          </tr>
        </tbody>
        <tfoot>
          <tr>
            <th scope="row">Outstanding paper</th>
            <td className="sw-num" data-testid={`outstanding-${register.direction}`}>
              <Figure minor={register.outstandingMinor} currency={currency} zero="zero" colour={false} />
            </td>
          </tr>
          <tr>
            <th scope="row" style={{ fontWeight: 400 }}>
              Account{" "}
              <Link href={`/accounting/accounts/${register.accountCode}`} className="sw-link sw-code">
                {register.accountCode}
              </Link>{" "}
              in the ledger
            </th>
            <td className="sw-num">
              <Figure minor={register.ledgerMinor} currency={currency} zero="zero" colour={false} />
            </td>
          </tr>
          <tr>
            <th scope="row" style={{ fontWeight: 400 }}>Difference</th>
            <td className="sw-num" data-testid={`difference-${register.direction}`}>
              <Figure minor={register.differenceMinor} currency={currency} />
            </td>
          </tr>
        </tfoot>
      </table>

      {mixed && (
        <p className="sw-sub mt-2 max-w-[60ch]" data-testid={`mixed-${register.direction}`}>
          This register holds paper in {currencies.join(", ")}, and the outstanding figure adds those face amounts
          together as they are written. Account {register.accountCode} is kept in {BOOK_CURRENCY} at the rate on each
          posting, so the two are not the same measurement and the difference above is a translation rather than a
          finding. The paper itself is right; only the subtraction is meaningless.
        </p>
      )}

      <div className="sw-scroll mt-3">
        <table className="sw-table">
          <caption className="sr-only">{title}, aged by the day each cheque may be presented</caption>
          <thead>
            <tr>
              {BUCKETS.map((b) => (
                <th key={b.key} className="sw-num" scope="col" title={b.hint}>{b.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              {BUCKETS.map((b) => (
                <td key={b.key} className="sw-num" data-testid={`bucket-${register.direction}-${b.key}`}>
                  <Figure minor={register.buckets[b.key]} currency={currency} colour={false} />
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
      <p className="sw-sub mt-2">
        Aged by the date each cheque may be presented, never by the date it was written &mdash; a cheque written in
        January and dated for July is four months away, not five months old.
        {BigInt(register.buckets.overdue || "0") > 0n && (
          <> Something in <strong>past due</strong> has gone by its date without clearing; a UAE bank refuses a cheque
            more than six months old, so that column has a shelf life.</>
        )}
      </p>
    </Panel>
  );
}

/* ---------------------------------------------------------------- the diary */

function ComingIn({ diary, onOpen, selected }: {
  diary: Diary; onOpen: (id: string) => void; selected: string | null;
}) {
  return (
    <Panel className="overflow-hidden">
      <PanelHead
        title="Coming in"
        sub={`Cheques received falling due on or before ${diary.until}, oldest date first.`}
      />
      {diary.received.length === 0 ? (
        <p className="sw-sub p-4">Nothing from a customer falls due in this window.</p>
      ) : (
        <div className="sw-scroll">
          <table className="sw-table">
            <caption className="sr-only">Cheques received falling due by {diary.until}</caption>
            <thead>
              <tr>
                <th style={{ width: "6.5rem" }}>Due</th>
                <th style={{ width: "6rem" }}>Number</th>
                <th>From</th>
                <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Amount</th>
              </tr>
            </thead>
            <tbody>
              {diary.received.map((c) => (
                <tr key={c.id} data-testid={`due-in-${c.number}`}>
                  <td>
                    {c.dueOn}
                    {c.daysToDue < 0 && <span className="sw-chip sw-chip-warn ml-1.5">past due</span>}
                  </td>
                  <td className="sw-code">
                    <OpenButton cheque={c} onOpen={onOpen} selected={selected} />
                  </td>
                  <td className="max-w-0 truncate">
                    {c.counterparty}
                    {c.bankName && <span className="sw-sub"> · {c.bankName}</span>}
                  </td>
                  <td className="sw-num"><Figure minor={c.amountMinor} currency={c.currency} colour={false} /></td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row" colSpan={3} style={{ textAlign: "end" }}>Expected in</th>
                <td className="sw-num" data-testid="diary-in-total">
                  <Figure minor={diary.receivedMinor} zero="zero" colour={false} />
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </Panel>
  );
}

/**
 * The half of the diary that can actually hurt.
 *
 * Each issued cheque is measured against the balance of the account it is drawn
 * on, cumulatively and in due order: the third cheque of the week is met out of
 * what the first two left. The cheques coming in are deliberately not counted
 * as cover, and the note under the table says so, because a business that meets
 * its own cheques out of cheques it has been handed is one dishonour away from
 * dishonouring its own.
 */
function GoingOut({ diary, onOpen, selected }: {
  diary: Diary; onOpen: (id: string) => void; selected: string | null;
}) {
  return (
    <Panel className="overflow-hidden">
      <PanelHead
        title="Going out"
        sub={`Our own cheques falling due on or before ${diary.until}, against the bank.`}
        chip={
          diary.uncoveredCount > 0 ? (
            <span className="sw-chip sw-chip-bad" data-testid="cover-chip">
              {diary.uncoveredCount} not covered
            </span>
          ) : diary.issued.length > 0 ? (
            <span className="sw-chip sw-chip-ok" data-testid="cover-chip">the bank can meet them</span>
          ) : null
        }
      />
      {diary.issued.length === 0 ? (
        <p className="sw-sub p-4">None of our cheques falls due in this window.</p>
      ) : (
        <div className="sw-scroll">
          <table className="sw-table">
            <caption className="sr-only">Cheques issued falling due by {diary.until}, against the bank balance</caption>
            <thead>
              <tr>
                <th style={{ width: "6.5rem" }}>Due</th>
                <th style={{ width: "6rem" }}>Number</th>
                <th>To</th>
                <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Amount</th>
                <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Committed by then</th>
                <th style={{ width: "9rem" }}>Cover</th>
              </tr>
            </thead>
            <tbody>
              {diary.issued.map((c) => (
                <tr key={c.id} data-testid={`due-out-${c.number}`}>
                  <td>
                    {c.dueOn}
                    {c.daysToDue < 0 && <span className="sw-chip sw-chip-warn ml-1.5">past due</span>}
                  </td>
                  <td className="sw-code">
                    <OpenButton cheque={c} onOpen={onOpen} selected={selected} />
                  </td>
                  <td className="max-w-0 truncate">{c.counterparty}</td>
                  <td className="sw-num"><Figure minor={c.amountMinor} currency={c.currency} colour={false} /></td>
                  <td className="sw-num"><Figure minor={c.cumulativeMinor} currency={c.currency} colour={false} /></td>
                  <td>
                    {c.covered ? (
                      <span className="sw-chip sw-chip-ok">covered</span>
                    ) : (
                      <>
                        <span className="sw-chip sw-chip-bad">short</span>
                        <span className="block text-[0.6875rem] sw-num">
                          <Figure minor={`-${c.shortfallMinor}`} currency={c.currency} />
                        </span>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row" colSpan={3} style={{ textAlign: "end" }}>Committed</th>
                <td className="sw-num" data-testid="diary-out-total">
                  <Figure minor={diary.issuedMinor} zero="zero" colour={false} />
                </td>
                <td className="sw-num"><Figure minor={diary.bankMinor} zero="zero" colour={false} /></td>
                <td>in the bank</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
      <p className="sw-sub px-3 py-2" style={{ borderTop: "1px solid var(--sw-line)" }}>
        Cover is measured against the bank alone. The{" "}
        <Figure minor={diary.receivedMinor} zero="zero" colour={false} /> of customers&rsquo; cheques due in the same
        window is shown beside this and deliberately not counted here: a business that meets its own cheques out of
        cheques it has been handed is one dishonour away from dishonouring its own.
        {diary.firstShortDay && (
          <> On <strong>{diary.firstShortDay}</strong> the commitments pass the balance.</>
        )}
      </p>
    </Panel>
  );
}

/* ------------------------------------------------------------- the register */

function RegisterTable({ title, register, onOpen, selected }: {
  title: string; register: DirectionRegister; onOpen: (id: string) => void; selected: string | null;
}) {
  // Live paper first — it is what somebody can still act on — then the settled
  // history underneath it, in the same table so the counts always add up.
  const rows = [...register.held, ...register.deposited, ...register.bounced, ...register.cleared, ...register.closed];
  return (
    <Panel className="overflow-hidden">
      <PanelHead
        title={title}
        sub={`${register.count} cheque${register.count === 1 ? "" : "s"}, ordered by the day each may be presented.`}
      />
      {rows.length === 0 ? (
        <p className="sw-sub p-4">Nothing here yet.</p>
      ) : (
        <div className="sw-scroll">
          <table className="sw-table">
            <caption className="sr-only">{title}, with the state of each cheque</caption>
            <thead>
              <tr>
                <th style={{ width: "6rem" }}>Number</th>
                <th>Counterparty</th>
                <th style={{ width: "6.5rem" }}>Written</th>
                <th style={{ width: "6.5rem" }}>Due</th>
                <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Amount</th>
                <th style={{ width: "9rem" }}>State</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id} data-testid={`cheque-${c.number}`}>
                  <td className="sw-code">
                    <OpenButton cheque={c} onOpen={onOpen} selected={selected} />
                  </td>
                  <td className="max-w-0 truncate">
                    {c.counterparty}
                    {c.bankName && <span className="sw-sub"> · {c.bankName}</span>}
                  </td>
                  <td style={{ color: "var(--sw-fg-muted)" }}>{c.writtenOn}</td>
                  <td>
                    {c.dueOn}
                    {c.outstanding && c.daysToDue < 0 && <span className="sw-chip sw-chip-warn ml-1.5">past due</span>}
                  </td>
                  <td className="sw-num"><Figure minor={c.amountMinor} currency={c.currency} colour={false} /></td>
                  <td>
                    <span className={`sw-chip ${TONE[c.status]}`} data-testid={`state-${c.number}`}>{SAYS[c.status]}</span>
                    {c.bounceCount > 0 && c.status !== "bounced" && (
                      <span className="block text-[0.6875rem]" style={{ color: "var(--sw-fg-muted)" }}>
                        bounced {c.bounceCount} time{c.bounceCount === 1 ? "" : "s"} before
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row" colSpan={4} style={{ textAlign: "end" }}>Outstanding</th>
                <td className="sw-num"><Figure minor={register.outstandingMinor} zero="zero" colour={false} /></td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </Panel>
  );
}

function OpenButton({ cheque, onOpen, selected }: {
  cheque: ChequeRow; onOpen: (id: string) => void; selected: string | null;
}) {
  return (
    <button
      type="button"
      className="sw-link sw-link-btn"
      onClick={() => onOpen(cheque.id)}
      aria-expanded={selected === cheque.id}
      data-testid={`open-${cheque.number}`}
    >
      {cheque.number}
    </button>
  );
}

function PanelHead({ title, sub, chip }: { title: string; sub: string; chip?: React.ReactNode }) {
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2"
      style={{ borderColor: "var(--sw-line)", background: "var(--sw-surface-2)" }}
    >
      <span className="sw-label">{title}</span>
      {chip}
      <span className="sw-sub w-full">{sub}</span>
    </div>
  );
}

/* ----------------------------------------------------------- one cheque */

/**
 * One piece of paper: what it is, where it has been, and the one step it can
 * take next. The buttons are drawn from the same allowed-transitions table the
 * server enforces, and a blocked one stays focusable and says why rather than
 * disappearing — a control that vanishes teaches nobody anything.
 */
function ChequePanel({ detail, busy, onAct }: {
  detail: DetailResponse;
  busy: string | null;
  onAct: (action: string, body: Record<string, unknown>, said: string) => void;
}) {
  const c = detail.cheque;
  const [on, setOn] = React.useState(today);
  const [reason, setReason] = React.useState("");
  const [fxRate, setFxRate] = React.useState("");
  const allowed = ALLOWED[c.status] ?? [];
  const can = (to: ChequeStatus) => allowed.includes(to);
  const running = (action: string) => busy === `${c.id}:${action}`;
  const rate = parseRate(fxRate);
  /* A rate is asked for once the cheque is foreign and at least one of the
   * steps still open to it would post. Asking on every foreign cheque would
   * demand one to bank a cheque, which posts nothing. */
  const ratePossiblyNeeded = allowed.some((to) => needsRate(c, to));

  /**
   * Why a step is unavailable, in the words the server would use. Returning the
   * sentence rather than a boolean is what lets the button stay focusable and
   * still explain itself.
   */
  const blocked = (to: ChequeStatus): string | undefined => {
    if (!can(to)) {
      return `Cheque ${c.number} is ${SAYS[c.status]}${c.statusOn ? ` as at ${c.statusOn}` : ""}, ` +
        `so this is not a step it can take.`;
    }
    if (to === "bounced" && !reason.trim()) return "A bounce needs the reason the bank gave.";
    if (needsRate(c, to) && rate === null) {
      return `Cheque ${c.number} is in ${c.currency}, so this entry needs the rate to ${BOOK_CURRENCY} on ${on}. ` +
        `The rate is not held on the cheque — a cheque moves on several different days and a rate belongs to one.`;
    }
    return undefined;
  };

  const fire = (to: ChequeStatus, action: string, said: string) => {
    if (blocked(to)) return;
    onAct(
      action,
      {
        on,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
        ...(needsRate(c, to) && rate !== null ? { fxRate: rate } : {}),
      },
      said,
    );
  };

  return (
    <Panel className="mt-4 overflow-hidden">
      <PanelHead
        title={`Cheque ${c.number} — ${c.counterparty}`}
        sub={
          `${c.direction === "RECEIVED" ? "Received from" : "Issued to"} ${c.counterparty}` +
          `${c.bankName ? `, drawn on ${c.bankName}` : ""}. Written ${c.writtenOn}, due ${c.dueOn}.`
        }
        chip={<span className={`sw-chip ${TONE[c.status]}`}>{SAYS[c.status]}</span>}
      />

      <div className="grid gap-4 p-4 lg:grid-cols-2">
        <table className="sw-table" style={{ maxWidth: "30rem" }}>
          <caption className="sr-only">The facts of cheque {c.number}</caption>
          <tbody>
            <tr>
              <th scope="row" style={{ fontWeight: 400 }}>Amount</th>
              <td className="sw-num">
                <Figure minor={c.amountMinor} currency={c.currency} colour={false} />
                {c.currency.toUpperCase() !== BOOK_CURRENCY && (
                  <span className="sw-code"> {c.currency}</span>
                )}
              </td>
            </tr>
            <tr>
              <th scope="row" style={{ fontWeight: 400 }}>Due in</th>
              <td className="sw-num">
                {c.daysToDue < 0 ? `${-c.daysToDue} days ago` : `${c.daysToDue} days`}
              </td>
            </tr>
            <tr>
              <th scope="row" style={{ fontWeight: 400 }}>Held in account</th>
              <td className="sw-num sw-code">
                <Link href={`/accounting/accounts/${c.accountCode}`} className="sw-link">{c.accountCode}</Link>
              </td>
            </tr>
            <tr>
              <th scope="row" style={{ fontWeight: 400 }}>Bank account when it clears</th>
              <td className="sw-num sw-code">{c.bankAccount}</td>
            </tr>
            {c.bounceReason && (
              <tr>
                <th scope="row" style={{ fontWeight: 400 }}>Last returned unpaid</th>
                <td className="sw-num">{c.bounceReason}</td>
              </tr>
            )}
          </tbody>
        </table>

        <div>
          <div className="sw-label">What happened to it</div>
          <table className="sw-table mt-2">
            <caption className="sr-only">Every event against cheque {c.number}, in order</caption>
            <thead>
              <tr>
                <th style={{ width: "6.5rem" }}>Date</th>
                <th style={{ width: "8rem" }}>Event</th>
                <th>Detail</th>
                <th style={{ width: "7rem" }}>Journal</th>
              </tr>
            </thead>
            <tbody>
              {detail.history.map((h, i) => (
                <tr key={`${h.on}-${h.kind}-${i}`} data-testid={`event-${i}`}>
                  <td>{h.on}</td>
                  <td style={{ color: "var(--sw-fg-muted)" }}>{h.kind}</td>
                  <td className="max-w-0 truncate">{h.detail ?? <span className="sw-zero">–</span>}</td>
                  <td>
                    {h.reference ? (
                      <Link href="/accounting/journals" className="sw-link sw-code" style={{ fontSize: "0.75rem" }}>
                        {h.reference}
                      </Link>
                    ) : (
                      <span className="sw-sub">no journal</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="sw-sub mt-2 max-w-[70ch]">
            Handing a cheque to the bank raises no journal, and should not: the paper moved from a drawer to a counter
            and nothing the business owns changed.
          </p>
        </div>
      </div>

      <div className="p-4" style={{ borderTop: "1px solid var(--sw-line)" }}>
        <div className="sw-label">Move it on</div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="On">
            <input type="date" className="sw-input" value={on} onChange={(e) => setOn(e.target.value)} />
          </Field>
          <Field label="Reason (required for a bounce)">
            <input
              className="sw-input"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="insufficient funds"
              data-testid="reason"
            />
          </Field>
          {ratePossiblyNeeded && (
            <Field label={`Rate — one ${c.currency} in ${BOOK_CURRENCY}`}>
              <input
                className={`sw-input sw-cell-num ${fxRate.trim() && rate === null ? "sw-cell-invalid" : ""}`}
                inputMode="decimal"
                value={fxRate}
                aria-invalid={Boolean(fxRate.trim()) && rate === null ? true : undefined}
                onChange={(e) => setFxRate(e.target.value)}
                placeholder="0.9793"
                data-testid="move-fx-rate"
              />
              <span className="sw-sub">
                The rate on the day above. Banking it needs none — that step posts nothing.
              </span>
            </Field>
          )}
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {STEPS.map((s) => (
            <button
              key={s.action}
              type="button"
              className={`sw-btn sw-btn-sm ${s.primary ? "sw-btn-primary" : ""}`}
              aria-disabled={blocked(s.to) ? true : undefined}
              title={blocked(s.to)}
              data-testid={`action-${s.action}`}
              disabled={running(s.action)}
              onClick={() => fire(s.to, s.action, s.said(c))}
            >
              {running(s.action) ? "…" : s.label}
            </button>
          ))}
        </div>

        <p className="sw-sub mt-3 max-w-[75ch]" role="status" data-testid="cheque-blocker">
          {allowed.length === 0 ? (
            <>
              Nothing further is possible from {SAYS[c.status]} — the money moved, and a posted entry is corrected by
              reversing it rather than by walking the status backwards.
            </>
          ) : can("bounced") && !reason.trim() ? (
            <>
              A bounce needs the reason the bank gave. Under UAE law a dishonoured cheque is an executive instrument, so
              the reason and the date are what any recovery rests on &mdash; and they are what tells you whether to
              present it again or to stop.
            </>
          ) : ratePossiblyNeeded && rate === null ? (
            <>
              Cheque {c.number} is in {c.currency}. Every step here that moves money writes its entry in{" "}
              {BOOK_CURRENCY}, so it needs the rate on the day above; the cheque itself stays in {c.currency}, which is
              what it is worth to whoever is holding it. Banking it is the exception and needs no rate, because that
              step posts nothing.
            </>
          ) : (
            <>From {SAYS[c.status]} this cheque can be {allowed.map((a) => ACT[a]).join(", ")}.</>
          )}
        </p>
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------------- the form */

function RecordCheque({ busy, onRecord }: {
  busy: boolean;
  onRecord: (cheque: Record<string, unknown>) => void;
}) {
  const [f, setF] = React.useState({
    direction: "RECEIVED" as Direction,
    number: "",
    counterparty: "",
    bankName: "",
    writtenOn: today(),
    dueOn: "",
    amount: "",
    currency: BOOK_CURRENCY,
    fxRate: "",
    settlesId: "",
    bankAccount: "1010",
  });
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));

  const currency = f.currency.trim().toUpperCase();
  const foreign = isCurrencyCode(currency) && currency !== BOOK_CURRENCY;
  /* Parsed at the cheque's own exponent, not at two decimals. A Kuwaiti cheque
   * for 250 dinars is 250,000 fils and a dirham cheque for 250 is 25,000 —
   * reading both as "250 at two places" is wrong by a factor of ten for the
   * one that is not a dirham, and `parseAmount` treats "250" and "250.000"
   * identically once it knows which currency it is reading. */
  const amount = parseAmount(f.amount, currency);
  const rate = parseRate(f.fxRate);

  const blocker =
    !f.number.trim() ? "The number on the paper, please — it is what the bank and the register both quote." :
    !f.counterparty.trim() ? (f.direction === "RECEIVED" ? "Who wrote it?" : "Who is it written to?") :
    !isCurrencyCode(currency) ? "A currency is a three-letter code, such as AED or SAR." :
    amount === null || amount <= 0n ? "How much is it for?" :
    foreign && rate === null ? `A cheque in ${currency} needs its rate to ${BOOK_CURRENCY} on the day it changed hands — the ledger is kept in ${BOOK_CURRENCY}, and the cheque stays in ${currency}.` :
    !f.writtenOn ? "When was it written?" :
    !f.dueOn ? "What date does it carry? That date is the whole point of a post-dated cheque." :
    f.dueOn < f.writtenOn ? "A cheque cannot fall due before it is written — check which way round the dates went in." :
    null;

  const received = f.direction === "RECEIVED";

  return (
    <Panel className="mb-4 p-4">
      <div className="sw-label">Record a cheque</div>
      <p className="sw-sub mt-1 max-w-[75ch]">
        This posts the first of the three journals now: the debt changes form. A cheque taken from a customer moves out
        of trade receivables into cheques in hand; a cheque written to a supplier moves out of trade payables into
        cheques issued. Nothing touches the bank until it clears.
      </p>

      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Which way">
          <select
            className="sw-select"
            value={f.direction}
            onChange={(e) => set("direction", e.target.value as Direction)}
            data-testid="direction"
          >
            <option value="RECEIVED">Received from a customer</option>
            <option value="ISSUED">Issued to a supplier</option>
          </select>
        </Field>
        <Field label="Cheque number">
          <input className="sw-input sw-code" value={f.number} onChange={(e) => set("number", e.target.value)} placeholder="100477" />
        </Field>
        <Field label={received ? "Drawn by" : "Payable to"}>
          <input className="sw-input" value={f.counterparty} onChange={(e) => set("counterparty", e.target.value)} placeholder="Al Marri Trading LLC" />
        </Field>
        <Field label="Drawn on (bank)">
          <input className="sw-input" value={f.bankName} onChange={(e) => set("bankName", e.target.value)} placeholder="Emirates NBD" />
        </Field>
        <Field label="Written on">
          <input type="date" className="sw-input" value={f.writtenOn} onChange={(e) => set("writtenOn", e.target.value)} />
        </Field>
        <Field label="Dated for (may be presented)">
          <input type="date" className="sw-input" value={f.dueOn} onChange={(e) => set("dueOn", e.target.value)} />
        </Field>
        <Field label="Currency">
          <input
            className="sw-input sw-code"
            value={f.currency}
            onChange={(e) => set("currency", e.target.value.toUpperCase())}
            placeholder={BOOK_CURRENCY}
            data-testid="cheque-currency"
          />
        </Field>
        <Field label={`Amount on the cheque, in ${isCurrencyCode(currency) ? currency : "its own currency"}`}>
          <input className="sw-input sw-cell-num" inputMode="decimal" value={f.amount} onChange={(e) => set("amount", e.target.value)} placeholder="105,000.00" />
        </Field>
        {foreign && (
          <Field label={`Rate — one ${currency} in ${BOOK_CURRENCY}`}>
            <input
              className={`sw-input sw-cell-num ${f.fxRate.trim() && rate === null ? "sw-cell-invalid" : ""}`}
              inputMode="decimal"
              value={f.fxRate}
              aria-invalid={Boolean(f.fxRate.trim()) && rate === null ? true : undefined}
              onChange={(e) => set("fxRate", e.target.value)}
              placeholder="0.9793"
              data-testid="cheque-fx-rate"
            />
            <span className="sw-sub">
              The rate on the day the paper changed hands. It is not kept on the cheque: a cheque moves on several
              different days and a rate belongs to one of them.
            </span>
          </Field>
        )}
        <Field label={received ? "Invoice it settles" : "Bill it settles"}>
          <input className="sw-input" value={f.settlesId} onChange={(e) => set("settlesId", e.target.value)} placeholder="optional" />
        </Field>
        <Field label="Clears through account">
          <input className="sw-input sw-code" value={f.bankAccount} onChange={(e) => set("bankAccount", e.target.value)} placeholder="1010" />
        </Field>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3" style={{ borderTop: "1px solid var(--sw-line)", paddingTop: "0.75rem" }}>
        <button
          type="button"
          className="sw-btn sw-btn-primary"
          disabled={blocker !== null || busy}
          aria-disabled={blocker !== null || busy || undefined}
          data-testid="save-cheque"
          onClick={() => {
            if (blocker || amount === null) return;
            onRecord({
              direction: f.direction,
              number: f.number.trim(),
              counterparty: f.counterparty.trim(),
              bankName: f.bankName.trim() || null,
              bankAccount: f.bankAccount.trim() || "1010",
              writtenOn: f.writtenOn,
              dueOn: f.dueOn,
              amountMinor: amount.toString(),
              currency,
              ...(foreign && rate !== null ? { fxRate: rate } : {}),
              settlesId: f.settlesId.trim() || null,
            });
          }}
        >
          {busy ? "Recording…" : "Record the cheque"}
        </button>
        {blocker && <span className="sw-sub" role="status" data-testid="record-blocker">{blocker}</span>}
        {!blocker && amount !== null && (
          <span className="sw-sub" data-testid="record-preview">
            {received ? (
              <>Dr 1050 Cheques in hand <Figure minor={amount} currency={currency} colour={false} /> · Cr 1100 Trade
                receivables <Figure minor={amount} currency={currency} colour={false} /></>
            ) : (
              <>Dr 2000 Trade payables <Figure minor={amount} currency={currency} colour={false} /> · Cr 2050 Cheques
                issued <Figure minor={amount} currency={currency} colour={false} /></>
            )}
            {" "}· presentable from {f.dueOn} ({fmtMinor(amount, currency)} due that day)
            {foreign && (
              <> · each line carries {currency} at {f.fxRate.trim()}, and the ledger holds its {BOOK_CURRENCY} value</>
            )}
          </span>
        )}
      </div>
    </Panel>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="sw-label">{label}</span>
      <span className="mt-1 block">{children}</span>
    </label>
  );
}
