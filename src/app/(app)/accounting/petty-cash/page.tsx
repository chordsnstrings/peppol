"use client";

import * as React from "react";
import Link from "next/link";
import { api, ApiError, useEntityId, useLedgerQuery } from "@/components/ledger/use-ledger";
import { Figure, PageHead, Panel, ErrorNote, Loading, Empty } from "@/components/ledger/primitives";
import { useAsk } from "@/components/ledger/ask";
import { fmtMinor, parseAmount } from "@/lib/ledger/format";

/**
 * The custodian's screen.
 *
 * One thing on it matters more than everything else: cash on hand plus the
 * receipts in the tin must equal the float. So that sum is drawn as a sum —
 * two figures, a rule, a total, and a chip that says whether it holds — at the
 * top of the page and again against the fund being looked at. A float that does
 * not reconcile has lost money or lost paper, and neither gets better by being
 * discovered at the year-end.
 */

interface FundState {
  fundId: string; code: string; name: string; custodian: string;
  currency: string; status: string; accountCode: string;
  floatMinor: string; openedMinor: string; returnedMinor: string; imprestMinor: string;
  cashMinor: string; unreimbursedMinor: string; unreimbursedVatMinor: string;
  differenceMinor: string; reconciled: boolean;
  receiptCount: number; movementCount: number; lastMovedOn: string | null;
}

interface FundListResponse {
  funds: FundState[];
  summary: {
    fundCount: number; activeCount: number;
    floatMinor: string; cashMinor: string;
    unreimbursedMinor: string; unreimbursedVatMinor: string;
    outOfBalanceCount: number;
  };
}

interface MovementRow {
  id: string; seq: number; kind: "OPENING" | "SPEND" | "REIMBURSE" | "RETURN";
  movedOn: string; description: string;
  amountMinor: string; accountCode: string | null;
  vatMinor: string; recoverableVatMinor: string;
  supplierTrn: string | null; receiptRef: string | null;
  entryId: string | null; entryReference: string | null;
  outstanding: boolean; cashAfterMinor: string;
}

interface FundDetailResponse {
  fund: FundState;
  movements: MovementRow[];
}

/** What a movement does to the cash in the tin, said in words rather than signs. */
const KIND: Record<MovementRow["kind"], { label: string; into: boolean }> = {
  OPENING: { label: "float advanced", into: true },
  SPEND: { label: "spent", into: false },
  REIMBURSE: { label: "reimbursed", into: true },
  RETURN: { label: "returned", into: false },
};

/** The accounts a petty cash receipt realistically lands in. */
const ACCOUNTS = [
  ["6900", "Other operating expenses"],
  ["6400", "Travel and entertainment"],
  ["6300", "Government fees and licences"],
  ["6450", "Repairs and maintenance"],
  ["6150", "Utilities"],
  ["6200", "Marketing and advertising"],
];

const today = () => new Date().toISOString().slice(0, 10);

export default function PettyCashPage() {
  const entityId = useEntityId();
  const [selected, setSelected] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [opening, setOpening] = React.useState(false);
  const ask = useAsk();

  const q = useLedgerQuery<FundListResponse>(entityId ? `/api/ledger/petty-cash?entityId=${entityId}` : null);
  const detail = useLedgerQuery<FundDetailResponse>(
    entityId && selected ? `/api/ledger/petty-cash?entityId=${entityId}&fundId=${encodeURIComponent(selected)}` : null,
    [selected],
  );

  const act = async (key: string, body: Record<string, unknown>) => {
    setBusy(key); setErr(null); setMsg(null);
    try {
      const r = await api<Record<string, unknown>>("/api/ledger/petty-cash", {
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

  const runFund = async (f: FundState, action: "reimburse" | "return" | "close") => {
    if (action === "return") {
      const answer = await ask({
        title: `How much cash is ${f.custodian} handing back from ${f.code}?`,
        detail:
          `The tin holds ${fmtMinor(f.cashMinor, f.currency, { zero: "zero" })} in notes. An entry is posted for ` +
          "what comes back — into the bank, out of petty cash — and the float in force is permanently reduced by " +
          "the same amount, so cash on hand plus receipts still equals the float afterwards.",
        reason: {
          label: "Amount",
          placeholder: "250.00",
          hint: `In ${f.currency}, written with the fils: 250.00, not 250. It cannot be more than the cash actually in the tin.`,
        },
        confirmLabel: "Post the return",
      });
      if (answer === null) return;
      const amount = parseAmount(answer, f.currency);
      if (amount === null || amount <= 0n) { setErr("That is not an amount."); return; }
      const r = await act(`${f.fundId}:return`, { action: "return", fundId: f.fundId, amountMinor: amount.toString() });
      if (r) setMsg(`${f.code}: cash returned and posted as ${String(r.reference)}. The float is now smaller by the same amount.`);
      return;
    }
    if (action === "close") {
      const go = await ask({
        title: `Close ${f.code} — ${f.name}?`,
        detail:
          "A closed float takes no further movements: no spending, no reimbursement, no cash back. Its history and " +
          "the entries raised from it stay exactly where they are, but the float cannot be reopened from here — a " +
          `new one has to be opened for ${f.custodian} instead. The ledger refuses this unless the tin is empty on ` +
          "both sides, cash and receipts.",
        confirmLabel: "Close the float",
        destructive: true,
      });
      if (go === null) return;
      const r = await act(`${f.fundId}:close`, { action: "close", fundId: f.fundId });
      if (r) setMsg(`${f.code} is closed.`);
      return;
    }
    const r = await act(`${f.fundId}:reimburse`, { action: "reimburse", fundId: f.fundId });
    if (r) {
      setMsg(
        `${f.code}: ${String(r.receiptCount)} receipt${r.receiptCount === 1 ? "" : "s"} reimbursed as ` +
          `${String(r.reference)}. The float is back at its imprest amount.`,
      );
    }
  };

  if (!entityId) return <Loading label="Choosing an entity…" />;
  const funds = q.data?.funds ?? [];

  return (
    <>
      <PageHead
        title="Petty cash"
        sub="Imprest floats: a fixed sum of cash held by a named custodian. Cash on hand plus the receipts in the tin equals the float, always — a reimbursement pays out exactly what was spent, so the float comes back to the same figure it started at."
        actions={
          <button type="button" className="sw-btn" onClick={() => setOpening((o) => !o)} data-testid="new-fund">
            {opening ? "Cancel" : "Open a float"}
          </button>
        }
      />

      {err && <ErrorNote>{err}</ErrorNote>}
      {msg && <div className="sw-note mb-3" role="status" data-testid="petty-cash-result">{msg}</div>}
      {q.error && <ErrorNote>{q.error}</ErrorNote>}

      {q.data && q.data.summary.fundCount > 0 && (
        <Panel className="mb-4 p-4">
          <div className="sw-label">The imprest identity, across every active float</div>
          <Identity
            cash={q.data.summary.cashMinor}
            receipts={q.data.summary.unreimbursedMinor}
            float={q.data.summary.floatMinor}
            reconciled={q.data.summary.outOfBalanceCount === 0}
            testId="all-funds"
          />
          <p className="sw-sub mt-2 max-w-[70ch]">
            {q.data.summary.outOfBalanceCount === 0 ? (
              <>
                Every float adds up. {q.data.summary.activeCount} active float
                {q.data.summary.activeCount === 1 ? "" : "s"}, holding{" "}
                <Figure minor={q.data.summary.unreimbursedVatMinor} zero="zero" colour={false} /> of input VAT in
                receipts that have not yet reached a VAT return.
              </>
            ) : (
              <span style={{ color: "var(--sw-neg)" }}>
                {q.data.summary.outOfBalanceCount} float{q.data.summary.outOfBalanceCount === 1 ? " does" : "s do"} not
                add up. Count the cash and the receipts against the float below before anything else.
              </span>
            )}
          </p>
        </Panel>
      )}

      {opening && (
        <OpenFloat
          busy={busy === "open"}
          onOpen={async (fund) => {
            const r = await act("open", { action: "open", ...fund });
            if (r) {
              setOpening(false);
              setSelected(String(r.fundId));
              setMsg(`Float ${fund.code} opened and posted as ${String(r.reference)} — the cash left the bank for the tin.`);
            }
          }}
        />
      )}

      {q.loading && !q.data && <Loading />}
      {q.data && funds.length === 0 && (
        <Empty>No petty cash floats yet. Open one above: a fixed sum, a named custodian, and every receipt against it.</Empty>
      )}

      {funds.length > 0 && (
        <Panel className="overflow-hidden">
          <div className="sw-scroll">
            <table className="sw-table">
              <caption className="sr-only">Petty cash floats, their cash on hand and the receipts held against them</caption>
              <thead>
                <tr>
                  <th style={{ width: "7rem" }}>Code</th>
                  <th>Float and custodian</th>
                  <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Float</th>
                  <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Cash on hand</th>
                  <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Receipts held</th>
                  <th style={{ width: "9rem" }}>Reconciles</th>
                  <th style={{ width: "17rem" }}><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {funds.map((f) => (
                  <tr key={f.fundId} data-testid={`fund-${f.code}`}>
                    <td className="sw-code">
                      <button
                        type="button"
                        className="sw-link sw-link-btn"
                        onClick={() => setSelected(selected === f.fundId ? null : f.fundId)}
                        aria-expanded={selected === f.fundId}
                        data-testid={`fund-open-${f.code}`}
                      >
                        {f.code}
                      </button>
                    </td>
                    <td className="max-w-0 truncate">
                      {f.name}
                      <span className="sw-sub"> · {f.custodian}</span>
                      {f.status === "closed" && <span className="sw-chip ml-2">closed</span>}
                    </td>
                    <td className="sw-num"><Figure minor={f.imprestMinor} currency={f.currency} colour={false} /></td>
                    <td className="sw-num"><Figure minor={f.cashMinor} currency={f.currency} zero="zero" colour={false} /></td>
                    <td className="sw-num">
                      <Figure minor={f.unreimbursedMinor} currency={f.currency} zero="zero" colour={false} />
                      {f.receiptCount > 0 && (
                        <span className="block text-[0.6875rem]" style={{ color: "var(--sw-fg-muted)" }}>
                          {f.receiptCount} receipt{f.receiptCount === 1 ? "" : "s"}
                        </span>
                      )}
                    </td>
                    <td>
                      <span className={`sw-chip ${f.reconciled ? "sw-chip-ok" : "sw-chip-bad"}`} data-testid={`fund-chip-${f.code}`}>
                        {f.reconciled ? "adds up" : "out of balance"}
                      </span>
                      {!f.reconciled && (
                        <span className="block text-[0.6875rem] sw-num">
                          <Figure minor={f.differenceMinor} currency={f.currency} />
                        </span>
                      )}
                    </td>
                    <td>
                      <span className="flex flex-wrap gap-1.5 py-1">
                        {f.status === "active" && (
                          <>
                            <button
                              type="button"
                              className="sw-btn sw-btn-sm sw-btn-primary"
                              disabled={busy === `${f.fundId}:reimburse` || f.receiptCount === 0}
                              aria-disabled={f.receiptCount === 0 || undefined}
                              data-testid={`fund-reimburse-${f.code}`}
                              onClick={() => runFund(f, "reimburse")}
                            >
                              {busy === `${f.fundId}:reimburse` ? "…" : "Reimburse"}
                            </button>
                            <button
                              type="button"
                              className="sw-btn sw-btn-sm"
                              disabled={busy === `${f.fundId}:return`}
                              onClick={() => runFund(f, "return")}
                            >
                              Return cash
                            </button>
                            <button
                              type="button"
                              className="sw-btn sw-btn-sm"
                              disabled={busy === `${f.fundId}:close`}
                              onClick={() => runFund(f, "close")}
                            >
                              Close
                            </button>
                          </>
                        )}
                        {f.status !== "active" && <span className="sw-sub">—</span>}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row" colSpan={2} style={{ textAlign: "end" }}>Active floats</th>
                  <td className="sw-num"><Figure minor={q.data?.summary.floatMinor} zero="zero" colour={false} /></td>
                  <td className="sw-num"><Figure minor={q.data?.summary.cashMinor} zero="zero" colour={false} /></td>
                  <td className="sw-num"><Figure minor={q.data?.summary.unreimbursedMinor} zero="zero" colour={false} /></td>
                  <td colSpan={2} />
                </tr>
              </tfoot>
            </table>
          </div>
          <p className="sw-sub px-3 py-2" style={{ borderTop: "1px solid var(--sw-line)" }}>
            A receipt does not reach the general ledger on its own. The expenses are posted in one entry when the
            float is reimbursed &mdash; that is the imprest treatment, and it is also the moment somebody other than
            the custodian has seen the paper. VAT is only reclaimed where the receipt shows the supplier&rsquo;s TRN
            (UAE VAT Decree-Law Art 55); everywhere else it is added to the expense, because VAT that cannot be
            reclaimed is part of what the thing cost.
          </p>
        </Panel>
      )}

      {selected && detail.error && <ErrorNote>{detail.error}</ErrorNote>}
      {selected && detail.data && (
        <FundPanel
          detail={detail.data}
          busy={busy}
          onSpend={async (spend) => {
            const r = await act("spend", { action: "spend", fundId: detail.data!.fund.fundId, ...spend });
            if (r) {
              const state = r.state as unknown as FundState;
              setMsg(
                `Receipt recorded. The tin should now hold ${fmtMinor(state.cashMinor, state.currency, { zero: "zero" })} ` +
                  `against ${state.receiptCount} receipt${state.receiptCount === 1 ? "" : "s"} — still the float, counted a different way.`,
              );
            }
          }}
        />
      )}
    </>
  );
}

/* --------------------------------------------------------------- the identity */

/**
 * Cash + receipts = float, drawn as an addition. The chip is not the only
 * signal — the difference row appears with its own figure — so a reader who
 * cannot separate the colours still sees which line is wrong.
 */
function Identity({ cash, receipts, float, reconciled, currency = "AED", testId }: {
  cash: string; receipts: string; float: string; reconciled: boolean;
  currency?: string; testId: string;
}) {
  const difference = BigInt(cash) + BigInt(receipts) - BigInt(float);
  return (
    <table className="sw-table mt-3" style={{ maxWidth: "34rem" }}>
      <caption className="sr-only">Cash on hand plus unreimbursed receipts against the float</caption>
      <tbody>
        <tr>
          <th scope="row" style={{ textAlign: "start", fontWeight: 400 }}>Cash on hand</th>
          <td className="sw-num" data-testid={`${testId}-cash`}>
            <Figure minor={cash} currency={currency} zero="zero" colour={false} />
          </td>
        </tr>
        <tr>
          <th scope="row" style={{ textAlign: "start", fontWeight: 400 }}>
            <span aria-hidden="true">+ </span>Receipts not yet reimbursed
          </th>
          <td className="sw-num" data-testid={`${testId}-receipts`}>
            <Figure minor={receipts} currency={currency} zero="zero" colour={false} />
          </td>
        </tr>
      </tbody>
      <tfoot>
        <tr>
          <th scope="row" style={{ textAlign: "start" }}>The float</th>
          <td className="sw-num" data-testid={`${testId}-float`}>
            <Figure minor={float} currency={currency} zero="zero" colour={false} />
          </td>
        </tr>
        <tr>
          <th scope="row" style={{ textAlign: "start", fontWeight: 400 }}>
            <span className={`sw-chip ${reconciled ? "sw-chip-ok" : "sw-chip-bad"}`} data-testid={`${testId}-chip`}>
              {reconciled ? "adds up" : "out of balance"}
            </span>
          </th>
          <td className="sw-num" data-testid={`${testId}-difference`}>
            {difference === 0n ? <span className="sw-zero">–</span> : <Figure minor={difference.toString()} currency={currency} />}
          </td>
        </tr>
      </tfoot>
    </table>
  );
}

/* ------------------------------------------------------------- one float */

function FundPanel({ detail, busy, onSpend }: {
  detail: FundDetailResponse;
  busy: string | null;
  onSpend: (spend: Record<string, unknown>) => void;
}) {
  const f = detail.fund;
  return (
    <Panel className="mt-4 overflow-hidden">
      <div className="border-b px-3 py-2" style={{ borderColor: "var(--sw-line)", background: "var(--sw-surface-2)" }}>
        <span className="sw-label">
          {f.code} — {f.name}, held by {f.custodian}
        </span>
      </div>

      <div className="p-4">
        <Identity
          cash={f.cashMinor}
          receipts={f.unreimbursedMinor}
          float={f.imprestMinor}
          reconciled={f.reconciled}
          currency={f.currency}
          testId="fund"
        />
        <p className="sw-sub mt-2 max-w-[70ch]">
          The cash sits in account{" "}
          <Link href={`/accounting/accounts/${f.accountCode}`} className="sw-link">{f.accountCode}</Link>, which carries
          the float itself rather than a running balance — that is what the imprest system means.
          {BigInt(f.returnedMinor) > 0n && (
            <> <Figure minor={f.returnedMinor} currency={f.currency} colour={false} /> has been handed back, so the float in force is smaller than the {" "}
              <Figure minor={f.floatMinor} currency={f.currency} colour={false} /> it was opened with.</>
          )}
        </p>
      </div>

      {f.status === "active" && <SpendForm fund={f} busy={busy === "spend"} onSpend={onSpend} />}

      <div className="sw-scroll">
        <table className="sw-table">
          <caption className="sr-only">Every movement on {f.code}, oldest first, with the cash left in the tin</caption>
          <thead>
            <tr>
              <th style={{ width: "3rem" }} className="sw-num">#</th>
              <th style={{ width: "7rem" }}>Date</th>
              <th style={{ width: "8rem" }}>Movement</th>
              <th>Description</th>
              <th style={{ width: "5rem" }}>Account</th>
              <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Amount</th>
              <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>VAT reclaimed</th>
              <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Cash after</th>
              <th style={{ width: "7rem" }}>Journal</th>
            </tr>
          </thead>
          <tbody>
            {detail.movements.map((m) => (
              <tr key={m.id} data-testid={`movement-${m.seq}`}>
                <td className="sw-num" style={{ color: "var(--sw-fg-muted)" }}>{m.seq}</td>
                <td>{m.movedOn}</td>
                <td style={{ color: "var(--sw-fg-muted)" }}>
                  {KIND[m.kind].label}
                  {m.outstanding && <span className="sw-chip sw-chip-warn ml-1">held</span>}
                </td>
                <td className="max-w-0 truncate">
                  {m.description}
                  {m.receiptRef && <span className="sw-sub"> · {m.receiptRef}</span>}
                </td>
                <td className="sw-code">{m.accountCode ?? <span className="sw-zero">–</span>}</td>
                <td className="sw-num">
                  <Figure
                    minor={(KIND[m.kind].into ? BigInt(m.amountMinor) : -BigInt(m.amountMinor)).toString()}
                    currency={f.currency}
                  />
                </td>
                <td className="sw-num">
                  <Figure minor={m.recoverableVatMinor} currency={f.currency} colour={false} />
                  {BigInt(m.vatMinor) > BigInt(m.recoverableVatMinor) && (
                    <span className="block text-[0.6875rem]" style={{ color: "var(--sw-fg-muted)" }}>
                      no TRN — in the expense
                    </span>
                  )}
                </td>
                <td className="sw-num"><Figure minor={m.cashAfterMinor} currency={f.currency} zero="zero" colour={false} /></td>
                <td>
                  {m.entryReference ? (
                    <Link href="/accounting/journals" className="sw-link sw-code" style={{ fontSize: "0.75rem" }}>
                      {m.entryReference}
                    </Link>
                  ) : (
                    <span className="sw-sub">at reimbursement</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

/* -------------------------------------------------------------- the forms */

function SpendForm({ fund, busy, onSpend }: {
  fund: FundState;
  busy: boolean;
  onSpend: (spend: Record<string, unknown>) => void;
}) {
  const [s, setS] = React.useState({
    movedOn: today(), description: "", accountCode: "6900",
    amount: "", vat: "", supplierTrn: "", receiptRef: "",
  });
  const set = (k: keyof typeof s, v: string) => setS((x) => ({ ...x, [k]: v }));

  const amount = parseAmount(s.amount, fund.currency);
  const vat = parseAmount(s.vat, fund.currency) ?? 0n;
  const cash = BigInt(fund.cashMinor);

  // The same refusals the server makes, said before the request rather than
  // after it. The server stays the authority; this is only courtesy.
  const blocker =
    !s.description.trim() ? "Say what was bought." :
    amount === null || amount <= 0n ? "How much left the tin?" :
    vat === null || vat < 0n ? "VAT cannot be negative." :
    vat > amount ? "The VAT cannot be more than what was paid." :
    amount > cash ? "That is more than the tin holds. Reimburse the receipts already in it first." :
    s.supplierTrn.trim() && !/^\d{15}$/.test(s.supplierTrn.trim())
      ? "A UAE TRN is fifteen digits. Leave it empty and the VAT goes into the expense instead." :
    null;

  return (
    <div className="p-4" style={{ borderTop: "1px solid var(--sw-line)" }}>
      <div className="sw-label">Record a receipt</div>
      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Spent on">
          <input type="date" className="sw-input" value={s.movedOn} onChange={(e) => set("movedOn", e.target.value)} />
        </Field>
        <Field label="Description">
          <input className="sw-input" value={s.description} onChange={(e) => set("description", e.target.value)} placeholder="Couriered documents" />
        </Field>
        <Field label="Account">
          <select className="sw-select" value={s.accountCode} onChange={(e) => set("accountCode", e.target.value)}>
            {ACCOUNTS.map(([code, name]) => <option key={code} value={code}>{code} {name}</option>)}
          </select>
        </Field>
        <Field label="Receipt reference">
          <input className="sw-input" value={s.receiptRef} onChange={(e) => set("receiptRef", e.target.value)} placeholder="R-1042" />
        </Field>
        <Field label="Paid, VAT included">
          <input className="sw-input sw-cell-num" inputMode="decimal" value={s.amount} onChange={(e) => set("amount", e.target.value)} placeholder="52.50" />
        </Field>
        <Field label="Of which VAT">
          <input className="sw-input sw-cell-num" inputMode="decimal" value={s.vat} onChange={(e) => set("vat", e.target.value)} placeholder="2.50" />
        </Field>
        <Field label="Supplier TRN">
          <input className="sw-input" inputMode="numeric" value={s.supplierTrn} onChange={(e) => set("supplierTrn", e.target.value)} placeholder="100123456700003" />
        </Field>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="sw-btn sw-btn-primary"
          disabled={blocker !== null || busy}
          aria-disabled={blocker !== null || busy || undefined}
          data-testid="record-spend"
          onClick={() => {
            if (blocker || amount === null) return;
            onSpend({
              movedOn: s.movedOn,
              description: s.description.trim(),
              accountCode: s.accountCode,
              amountMinor: amount.toString(),
              vatMinor: (vat ?? 0n).toString(),
              supplierTrn: s.supplierTrn.trim() || null,
              receiptRef: s.receiptRef.trim() || null,
            });
            setS((x) => ({ ...x, description: "", amount: "", vat: "", supplierTrn: "", receiptRef: "" }));
          }}
        >
          {busy ? "Saving…" : "Record the receipt"}
        </button>
        {blocker && <span className="sw-sub" role="status" data-testid="spend-blocker">{blocker}</span>}
        {!blocker && (
          <span className="sw-sub" data-testid="spend-remaining">
            The tin holds <Figure minor={fund.cashMinor} currency={fund.currency} zero="zero" colour={false} />
            {amount !== null && amount > 0n && (
              <> · <Figure minor={(cash - amount).toString()} currency={fund.currency} zero="zero" colour={false} /> after this receipt</>
            )}
            {!s.supplierTrn.trim() && vat !== null && vat > 0n && (
              <> · with no TRN this VAT goes into {s.accountCode} rather than being reclaimed</>
            )}
          </span>
        )}
      </div>
    </div>
  );
}

function OpenFloat({ busy, onOpen }: {
  busy: boolean;
  onOpen: (fund: { code: string; name: string; custodian: string; floatMinor: string; accountCode: string; openedOn: string }) => void;
}) {
  const [f, setF] = React.useState({
    code: "", name: "", custodian: "", amount: "", accountCode: "1000", openedOn: today(),
  });
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));
  const amount = parseAmount(f.amount);

  const blocker =
    !f.code.trim() ? "Give the float a code." :
    !f.name.trim() ? "Name the float, so a reader knows which tin it is." :
    !f.custodian.trim() ? "Who holds it? A float with nobody's name against it is cash nobody has to account for." :
    amount === null || amount <= 0n ? "How much is the float?" :
    null;

  return (
    <Panel className="mb-4 p-4">
      <div className="sw-label">Open a petty cash float</div>
      <p className="sw-sub mt-1 max-w-[70ch]">
        This moves the money out of the bank and into the custodian&rsquo;s hands, and posts that entry now. The
        amount is the imprest amount: every reimbursement afterwards restores the tin to exactly this figure.
      </p>

      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Code"><input className="sw-input" value={f.code} onChange={(e) => set("code", e.target.value)} placeholder="PC-OPS" /></Field>
        <Field label="Name"><input className="sw-input" value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="Operations tin" /></Field>
        <Field label="Custodian"><input className="sw-input" value={f.custodian} onChange={(e) => set("custodian", e.target.value)} placeholder="Layla Haddad" /></Field>
        <Field label="Float"><input className="sw-input sw-cell-num" inputMode="decimal" value={f.amount} onChange={(e) => set("amount", e.target.value)} placeholder="2,000.00" /></Field>
        <Field label="Cash account"><input className="sw-input sw-code" value={f.accountCode} onChange={(e) => set("accountCode", e.target.value)} placeholder="1000" /></Field>
        <Field label="Advanced on"><input type="date" className="sw-input" value={f.openedOn} onChange={(e) => set("openedOn", e.target.value)} /></Field>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3" style={{ borderTop: "1px solid var(--sw-line)", paddingTop: "0.75rem" }}>
        <button
          type="button"
          className="sw-btn sw-btn-primary"
          disabled={blocker !== null || busy}
          aria-disabled={blocker !== null || busy || undefined}
          data-testid="save-fund"
          onClick={() => {
            if (blocker || amount === null) return;
            onOpen({
              code: f.code.trim(),
              name: f.name.trim(),
              custodian: f.custodian.trim(),
              floatMinor: amount.toString(),
              accountCode: f.accountCode.trim() || "1000",
              openedOn: f.openedOn,
            });
          }}
        >
          {busy ? "Opening…" : "Advance the float"}
        </button>
        {blocker && <span className="sw-sub" role="status" data-testid="fund-blocker">{blocker}</span>}
        {!blocker && amount !== null && (
          <span className="sw-sub" data-testid="fund-preview">
            Dr {f.accountCode.trim() || "1000"} <Figure minor={amount} colour={false} /> · Cr 1010 Bank{" "}
            <Figure minor={amount} colour={false} />
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
