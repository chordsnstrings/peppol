"use client";

import * as React from "react";
import Link from "next/link";
import { api, ApiError, useEntityId, useLedgerQuery } from "@/components/ledger/use-ledger";
import { Figure, PageHead, Panel, ErrorNote, Loading, Empty } from "@/components/ledger/primitives";
import { PartyEditForm, type PartyChange } from "@/components/ledger/party-edit";
import { parseAmount } from "@/lib/ledger/format";

/**
 * Customers and credit control.
 *
 * The screen is built around one distinction the numbers cannot make on their
 * own: a customer with no credit limit set is not a customer with a limit of
 * nothing. So the limit column never shows a figure where none exists — it says
 * "not set" and offers to set one, while a deliberate limit of nil is shown as
 * a real zero and labelled cash only. Showing a dash for both, or a big number
 * standing in for "no limit", is how a cash-only account quietly gets credit.
 *
 * The collections list suggests and never acts. Every hold on this page goes
 * through a reason box, because the person asked to release it three weeks from
 * now has to be able to see why it was placed.
 */

interface Row {
  code: string;
  name: string;
  nameAr: string | null;
  kind: string;
  trn: string | null;
  email: string | null;
  phone: string | null;
  currency: string;
  status: string;
  paymentTerms: number;
  outstandingMinor: string;
  overdueMinor: string;
  oldestOverdueDays: number | null;
  creditLimitMinor: string | null;
  limitSet: boolean;
  headroomMinor: string | null;
  overLimit: boolean;
  overdue: boolean;
  onHold: boolean;
  holdReason: string | null;
  openItems: number;
  summary: string;
}

interface DunningRow {
  code: string;
  name: string;
  currency: string;
  outstandingMinor: string;
  overdueMinor: string;
  oldestOverdueDays: number;
  paymentTerms: number;
  overLimit: boolean;
  onHold: boolean;
  suggested: "remind" | "demand" | "hold" | "refer";
  reason: string;
}

interface Statement {
  code: string;
  name: string;
  currency: string;
  from: string | null;
  to: string;
  openingMinor: string;
  lines: {
    date: string; number: string; reference: string; documentId: string; description: string;
    debitMinor: string; creditMinor: string; balanceMinor: string;
  }[];
  closingMinor: string;
  ageingShareMinor: string;
  agrees: boolean;
  note: string;
}

const ACTION_LABEL: Record<string, string> = {
  remind: "Send a reminder",
  demand: "Firm demand",
  hold: "Consider a hold",
  refer: "Refer for recovery",
};
const ACTION_TONE: Record<string, string> = {
  remind: "", demand: "sw-chip-warn", hold: "sw-chip-warn", refer: "sw-chip-bad",
};

export default function CustomersPage() {
  const entityId = useEntityId();
  const [asOf, setAsOf] = React.useState(() => new Date().toISOString().slice(0, 10));
  const [adding, setAdding] = React.useState(false);
  const [open, setOpen] = React.useState<string | null>(null);
  const [editing, setEditing] = React.useState<string | null>(null);
  /* Archived parties are off the working list by default and reachable, which
   * is the whole point of archiving rather than deleting: the record stays,
   * every document that names it still resolves, and somebody who archived the
   * wrong account can find it again. Until now nothing could show one. */
  const [showArchived, setShowArchived] = React.useState(false);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);

  const list = useLedgerQuery<{ asOf: string; counterparties: Row[] }>(
    entityId
      ? `/api/ledger/counterparties?entityId=${entityId}&asOf=${asOf}${showArchived ? "&includeArchived=1" : ""}`
      : null,
  );
  const dunning = useLedgerQuery<{ asOf: string; rows: DunningRow[]; totalOverdueMinor: string; note: string }>(
    entityId ? `/api/ledger/counterparties?entityId=${entityId}&view=dunning&asOf=${asOf}` : null,
  );

  const act = async (label: string, body: Record<string, unknown>, describe: string) => {
    setBusy(label); setErr(null); setMsg(null);
    try {
      await api("/api/ledger/counterparties", {
        method: "POST",
        body: JSON.stringify({ entityId, ...body }),
      });
      setMsg(describe);
      setAdding(false);
      setEditing(null);
      list.reload();
      dunning.reload();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "That did not work.");
    } finally {
      setBusy(null);
    }
  };

  if (!entityId) return <Loading label="Choosing an entity…" />;

  const rows = list.data?.counterparties ?? [];
  const totals = rows.reduce(
    (a, r) => ({
      outstanding: a.outstanding + BigInt(r.outstandingMinor),
      overdue: a.overdue + BigInt(r.overdueMinor),
    }),
    { outstanding: 0n, overdue: 0n },
  );

  return (
    <>
      <PageHead
        title="Customers and credit"
        sub="What each customer owes, how late it is on their own payment terms, and where they stand against their credit limit. A customer with no limit set is not a customer with a limit of nothing — the two are shown differently here because they mean opposite things."
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
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={showArchived}
                onChange={(e) => setShowArchived(e.target.checked)}
                data-testid="show-archived"
              />
              <span className="text-[0.8125rem]">Show archived</span>
            </label>
            <button
              type="button"
              className="sw-btn sw-btn-primary"
              onClick={() => { setAdding((a) => !a); setOpen(null); setEditing(null); }}
            >
              {adding ? "Cancel" : "Add customer"}
            </button>
          </>
        }
      />

      {err && <ErrorNote>{err}</ErrorNote>}
      {msg && <div className="sw-note mb-3" role="status" data-testid="customers-result">{msg}</div>}
      {list.error && <ErrorNote>{list.error}</ErrorNote>}
      {list.loading && !list.data && <Loading />}

      {adding && (
        <AddForm
          busy={busy === "create"}
          onAdd={(counterparty) =>
            act("create", { action: "create", counterparty }, `Added ${counterparty.code} ${counterparty.name}.`)
          }
        />
      )}

      {list.data && rows.length === 0 && (
        <Empty>No customers yet. Add one to start tracking what is owed and what it is worth chasing.</Empty>
      )}

      {rows.length > 0 && (
        <Panel className="mb-4 overflow-hidden">
          <div className="sw-scroll">
            <table className="sw-table">
              <caption className="sr-only">Customers and their credit standing as at {list.data?.asOf}</caption>
              <thead>
                <tr>
                  <th style={{ width: "7rem" }}>Code</th>
                  <th>Customer</th>
                  <th className="sw-num" style={{ width: "5rem" }}>Terms</th>
                  <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Owed</th>
                  <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Overdue</th>
                  <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Limit</th>
                  <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Headroom</th>
                  <th style={{ width: "14rem" }}><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <React.Fragment key={r.code}>
                    <tr>
                      <td className="sw-code">{r.code}</td>
                      <td className="max-w-0 truncate">
                        {r.name}
                        <span className="ms-1 inline-flex flex-wrap gap-1">
                          {r.status !== "active" && <span className="sw-chip sw-chip-warn">archived</span>}
                          {r.onHold && <span className="sw-chip sw-chip-bad">on hold</span>}
                          {r.overLimit && <span className="sw-chip sw-chip-bad">over limit</span>}
                          {r.overdue && <span className="sw-chip sw-chip-warn">{r.oldestOverdueDays} d late</span>}
                          {!r.limitSet && <span className="sw-chip">no limit set</span>}
                          {r.limitSet && r.creditLimitMinor === "0" && <span className="sw-chip">cash only</span>}
                        </span>
                      </td>
                      <td className="sw-num">{r.paymentTerms === 0 ? "on receipt" : `${r.paymentTerms} d`}</td>
                      <td className="sw-num"><Figure minor={r.outstandingMinor} currency={r.currency} /></td>
                      <td className="sw-num"><Figure minor={r.overdueMinor} currency={r.currency} /></td>
                      <td className="sw-num">
                        {/* Never a figure where no limit exists: a dash reads as
                            nil, and nil is the opposite answer. */}
                        {r.limitSet
                          ? <Figure minor={r.creditLimitMinor} currency={r.currency} zero="zero" />
                          : <span className="sw-sub">not set</span>}
                      </td>
                      <td className="sw-num" data-testid={`headroom-${r.code}`}>
                        {r.headroomMinor === null
                          ? <span className="sw-sub" title="No limit has been set, so there is no headroom to report">–</span>
                          : <Figure minor={r.headroomMinor} currency={r.currency} zero="zero" />}
                      </td>
                      <td>
                        <span className="flex flex-wrap gap-1 py-1">
                          <button
                            type="button"
                            className="sw-btn sw-btn-sm"
                            aria-expanded={open === r.code}
                            onClick={() => { setOpen(open === r.code ? null : r.code); setAdding(false); setEditing(null); }}
                          >
                            {open === r.code ? "Close" : "Statement"}
                          </button>
                          <button
                            type="button"
                            className="sw-btn sw-btn-sm"
                            aria-expanded={editing === r.code}
                            onClick={() => { setEditing(editing === r.code ? null : r.code); setAdding(false); setOpen(null); }}
                            data-testid={`edit-${r.code}`}
                          >
                            {editing === r.code ? "Close" : "Edit"}
                          </button>
                          {/* An archived party is not held, released or archived
                              again. Restoring is the one thing left to do with
                              it, besides correcting what it says. */}
                          {r.status === "active" ? (
                            <>
                              <HoldButton
                                row={r}
                                busy={busy === r.code}
                                onHold={(reason) =>
                                  act(r.code, { action: "hold", code: r.code, reason }, `${r.name} is on hold.`)
                                }
                                onRelease={(reason) =>
                                  act(r.code, { action: "release", code: r.code, reason }, `The hold on ${r.name} is released.`)
                                }
                              />
                              <button
                                type="button"
                                className="sw-btn sw-btn-sm"
                                aria-disabled={r.outstandingMinor !== "0" || undefined}
                                disabled={r.outstandingMinor !== "0" || busy === r.code}
                                title={r.outstandingMinor === "0" ? undefined : "They still have a balance on the sales ledger"}
                                onClick={() =>
                                  act(
                                    r.code,
                                    { action: "archive", code: r.code },
                                    `Archived ${r.name}. Every document that names them still resolves, and "Show archived" brings them back into view.`,
                                  )
                                }
                              >
                                Archive
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              className="sw-btn sw-btn-sm"
                              disabled={busy === r.code}
                              data-testid={`restore-${r.code}`}
                              onClick={() => act(r.code, { action: "restore", code: r.code }, `${r.name} is active again.`)}
                            >
                              Restore
                            </button>
                          )}
                        </span>
                      </td>
                    </tr>
                    <tr>
                      <td colSpan={8} className="sw-sub" style={{ paddingTop: 0 }}>{r.summary}</td>
                    </tr>
                    {open === r.code && (
                      <tr>
                        <td colSpan={8} style={{ background: "var(--sw-surface-2)", padding: "0.75rem" }}>
                          <StatementPanel entityId={entityId} code={r.code} to={asOf} />
                        </td>
                      </tr>
                    )}
                    {editing === r.code && (
                      <tr>
                        <td colSpan={8} style={{ background: "var(--sw-surface-2)", padding: "0.75rem" }}>
                          <PartyEditForm
                            party={r}
                            busy={busy === r.code}
                            onSave={(change: PartyChange) =>
                              act(r.code, { action: "update", code: r.code, change }, `Updated ${r.code} ${r.name}.`)
                            }
                          />
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row" colSpan={3} style={{ textAlign: "end" }}>Total</th>
                  <td className="sw-num" data-testid="customers-owed">
                    <Figure minor={totals.outstanding.toString()} zero="zero" />
                  </td>
                  <td className="sw-num" data-testid="customers-overdue">
                    <Figure minor={totals.overdue.toString()} zero="zero" />
                  </td>
                  <td colSpan={3} />
                </tr>
              </tfoot>
            </table>
          </div>
          <p className="sw-sub px-3 py-2" style={{ borderTop: "1px solid var(--sw-line)" }}>
            Every figure here is the customer&rsquo;s share of account 1100 Trade receivables, netted document by
            document exactly as the{" "}
            <Link href="/accounting/receivables" className="sw-link">ageing report</Link> nets it, so a statement
            and the ageing can never tell a customer two different things. Archiving takes a settled account off
            this list and deletes nothing — every invoice, receipt and statement that names them is untouched, and
            Show archived brings them back into view to be corrected or restored.
          </p>
        </Panel>
      )}

      <Collections data={dunning.data} error={dunning.error} loading={dunning.loading} />
    </>
  );
}

/* --------------------------------------------------------------- collections */

function Collections({
  data, error, loading,
}: {
  data: { asOf: string; rows: DunningRow[]; totalOverdueMinor: string; note: string } | null;
  error: string | null;
  loading: boolean;
}) {
  return (
    <Panel className="mb-4 overflow-hidden">
      <div className="border-b px-3 py-2" style={{ borderColor: "var(--sw-line)", background: "var(--sw-surface-2)" }}>
        <span className="sw-label">Who to chase, worst first</span>
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
      {loading && !data && <Loading />}
      {data && data.rows.length === 0 && (
        <div className="px-3 py-3"><Empty>Nothing is overdue. There is nobody to chase today.</Empty></div>
      )}
      {data && data.rows.length > 0 && (
        <div className="sw-scroll">
          <table className="sw-table">
            <caption className="sr-only">Overdue customers as at {data.asOf}, oldest debt first</caption>
            <thead>
              <tr>
                <th style={{ width: "7rem" }}>Code</th>
                <th style={{ width: "14rem" }}>Customer</th>
                <th className="sw-num" style={{ width: "5rem" }}>Late by</th>
                <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Overdue</th>
                <th style={{ width: "11rem" }}>Suggested</th>
                <th>Why</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.code} data-testid={`dunning-${r.code}`}>
                  <td className="sw-code">{r.code}</td>
                  <td className="max-w-0 truncate">{r.name}</td>
                  <td className="sw-num">{r.oldestOverdueDays} d</td>
                  <td className="sw-num"><Figure minor={r.overdueMinor} currency={r.currency} /></td>
                  <td>
                    <span className={`sw-chip ${ACTION_TONE[r.suggested] ?? ""}`}>{ACTION_LABEL[r.suggested]}</span>
                  </td>
                  <td className="sw-sub">{r.reason}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row" colSpan={3} style={{ textAlign: "end" }}>Total overdue</th>
                <td className="sw-num" data-testid="dunning-total">
                  <Figure minor={data.totalOverdueMinor} zero="zero" />
                </td>
                <td colSpan={2} />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
      {data && (
        <p className="sw-sub px-3 py-2" style={{ borderTop: "1px solid var(--sw-line)" }}>{data.note}</p>
      )}
    </Panel>
  );
}

/* ----------------------------------------------------------------- statement */

function StatementPanel({ entityId, code, to }: { entityId: string; code: string; to: string }) {
  const from = React.useMemo(() => `${to.slice(0, 4)}-01-01`, [to]);
  const { data, error, loading } = useLedgerQuery<Statement>(
    `/api/ledger/counterparties?entityId=${entityId}&view=statement&code=${encodeURIComponent(code)}&from=${from}&to=${to}`,
  );

  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (loading || !data) return <Loading label="Building the statement…" />;

  return (
    <>
      <div className="sw-scroll">
        <table className="sw-table">
          <caption className="sr-only">
            Statement of account for {data.name} from {data.from ?? "the beginning"} to {data.to}
          </caption>
          <thead>
            <tr>
              <th style={{ width: "7rem" }}>Date</th>
              {/* The customer knows the invoice number, not our journal
                  reference, so that is the column they reconcile against. */}
              <th style={{ width: "8rem" }}>Document</th>
              <th>Detail</th>
              <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Charged</th>
              <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Paid</th>
              <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Balance</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>{data.from}</td>
              <td />
              <td>Balance brought forward</td>
              <td className="sw-num"><span className="sw-zero">–</span></td>
              <td className="sw-num"><span className="sw-zero">–</span></td>
              <td className="sw-num" data-testid="statement-opening">
                <Figure minor={data.openingMinor} currency={data.currency} zero="zero" />
              </td>
            </tr>
            {data.lines.map((l, i) => (
              <tr key={`${l.documentId}-${i}`}>
                <td>{l.date}</td>
                <td className="sw-code" title={`Journal ${l.reference}`}>{l.number}</td>
                <td className="max-w-0 truncate">{l.description}</td>
                <td className="sw-num"><Figure minor={l.debitMinor} currency={data.currency} /></td>
                <td className="sw-num"><Figure minor={l.creditMinor} currency={data.currency} /></td>
                <td className="sw-num"><Figure minor={l.balanceMinor} currency={data.currency} zero="zero" /></td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row" colSpan={5} style={{ textAlign: "end" }}>Balance owed at {data.to}</th>
              <td className="sw-num" data-testid="statement-closing">
                <Figure minor={data.closingMinor} currency={data.currency} zero="zero" />
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
      <p className={data.agrees ? "sw-sub mt-2" : "sw-error mt-2"} role={data.agrees ? undefined : "alert"}>
        {data.note}
      </p>
    </>
  );
}

/* --------------------------------------------------------------------- holds */

function HoldButton({
  row, busy, onHold, onRelease,
}: {
  row: Row;
  busy: boolean;
  onHold: (reason: string) => void;
  onRelease: (reason: string) => void;
}) {
  const [asking, setAsking] = React.useState(false);
  const [reason, setReason] = React.useState("");
  const short = reason.trim().length < 4;

  if (!asking) {
    return (
      <button
        type="button"
        className="sw-btn sw-btn-sm"
        onClick={() => { setAsking(true); setReason(""); }}
        data-testid={`hold-${row.code}`}
      >
        {row.onHold ? "Release hold" : "Place on hold"}
      </button>
    );
  }

  return (
    <span className="flex flex-wrap items-center gap-1">
      <label className="sr-only" htmlFor={`reason-${row.code}`}>
        {row.onHold ? "Why release the hold?" : "Why hold this account?"}
      </label>
      <input
        id={`reason-${row.code}`}
        className="sw-input"
        style={{ width: "14rem" }}
        placeholder={row.onHold ? "Why release it?" : "Why hold it?"}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <button
        type="button"
        className="sw-btn sw-btn-sm"
        aria-disabled={short || busy || undefined}
        disabled={short || busy}
        title={short ? "A hold has to say why — the next person has to decide whether it still applies" : undefined}
        onClick={() => { (row.onHold ? onRelease : onHold)(reason.trim()); setAsking(false); }}
      >
        {busy ? "Saving…" : row.onHold ? "Release" : "Hold"}
      </button>
      <button type="button" className="sw-btn sw-btn-sm" onClick={() => setAsking(false)}>Cancel</button>
    </span>
  );
}

/* ----------------------------------------------------------------- add a row */

function AddForm({ busy, onAdd }: { busy: boolean; onAdd: (c: Record<string, unknown>) => void }) {
  const [f, setF] = React.useState({
    code: "", name: "", nameAr: "", trn: "", email: "", terms: "30",
    // "none" and "set" are kept as two states rather than one empty box,
    // because an empty box would send 0 and 0 is a real, different limit.
    limitMode: "none", limit: "",
  });
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));

  const terms = Number(f.terms);
  const trn = f.trn.trim();
  /* Through the ledger's own parser, not through a double multiplied by a
   * hundred. A credit limit is a minor-unit figure like any other, and a float
   * on a write path is wrong twice over: it rounds at the half-fils boundary
   * the way binary floating point happens to fall, and a hard-coded hundred is
   * out by a factor of ten for a three-decimal currency. The books here are
   * opened in dirhams, which is why nothing ever showed. */
  const limitMinor = f.limitMode === "set" ? parseAmount(f.limit.trim(), "AED") : null;
  const blocker =
    !f.code.trim() ? "Give the customer a code." :
    !/^[A-Za-z0-9._-]+$/.test(f.code.trim()) ? "A code is letters, digits, dots, dashes or underscores." :
    !f.name.trim() ? "Give the customer a name — it is what appears on their statement." :
    !Number.isInteger(terms) || terms < 0 || terms > 365 ? "Payment terms are a whole number of days, 0 to 365." :
    trn.length > 0 && !/^\d{15}$/.test(trn) ? "A UAE TRN is fifteen digits." :
    f.limitMode === "set" && (f.limit.trim() === "" || limitMinor === null)
      ? "Give the limit as an amount, e.g. 5000." :
    limitMinor !== null && limitMinor < 0n ? "A credit limit cannot be negative." :
    null;

  return (
    <Panel className="mb-4 p-4">
      <div className="sw-label">Add a customer</div>
      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Code"><input className="sw-input" value={f.code} onChange={(e) => set("code", e.target.value)} placeholder="C-0001" /></Field>
        <Field label="Name"><input className="sw-input" value={f.name} onChange={(e) => set("name", e.target.value)} /></Field>
        <Field label="العربية"><input className="sw-input" dir="rtl" value={f.nameAr} onChange={(e) => set("nameAr", e.target.value)} /></Field>
        <Field label="TRN"><input className="sw-input" inputMode="numeric" value={f.trn} onChange={(e) => set("trn", e.target.value)} placeholder="15 digits" /></Field>
        <Field label="Email"><input className="sw-input" type="email" value={f.email} onChange={(e) => set("email", e.target.value)} /></Field>
        <Field label="Payment terms (days)">
          <input className="sw-input" inputMode="numeric" value={f.terms} onChange={(e) => set("terms", e.target.value)} />
        </Field>
        <Field label="Credit limit">
          <select
            className="sw-select"
            value={f.limitMode}
            onChange={(e) => set("limitMode", e.target.value)}
            data-testid="limit-mode"
          >
            <option value="none">No limit set — not assessed yet</option>
            <option value="set">Set a limit</option>
          </select>
        </Field>
        <Field label="Limit amount">
          <input
            className="sw-input"
            inputMode="decimal"
            value={f.limit}
            disabled={f.limitMode === "none"}
            placeholder="5000"
            onChange={(e) => set("limit", e.target.value)}
          />
          <span className="sw-sub mt-1 block">
            {f.limitMode === "none"
              ? "Nothing will be checked before a sale until a limit exists."
              : "Enter 0 for a customer who gets no credit at all — that is a different answer from leaving it unset."}
          </span>
        </Field>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="sw-btn sw-btn-primary"
          aria-disabled={blocker !== null || busy || undefined}
          disabled={blocker !== null || busy}
          data-testid="add-customer"
          onClick={() =>
            onAdd({
              code: f.code.trim(),
              name: f.name.trim(),
              nameAr: f.nameAr.trim() || undefined,
              trn: trn || null,
              email: f.email.trim() || null,
              paymentTerms: terms,
              // null and a number are different answers, and the form keeps them
              // apart rather than sending 0 for "left blank".
              creditLimitMinor: limitMinor === null ? null : limitMinor.toString(),
            })
          }
        >
          {busy ? "Adding…" : "Add"}
        </button>
        {blocker && <span className="sw-sub" role="status" data-testid="customer-blocker">{blocker}</span>}
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
