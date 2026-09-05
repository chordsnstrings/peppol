"use client";

import * as React from "react";
import { api, ApiError, useEntityId, useLedgerQuery } from "@/components/ledger/use-ledger";
import { Figure, PageHead, Panel, ErrorNote, Loading, Empty, StatusChip } from "@/components/ledger/primitives";
import { useAsk } from "@/components/ledger/ask";
import { fmtMinor, parseAmount, toInput } from "@/lib/ledger/format";

interface Obligation {
  seq: number; description: string; timing: string;
  standalonePriceMinor: string; allocatedMinor: string; recognisedMinor: string;
  progressBps: number; satisfiedOn: string | null;
}
interface Contract {
  code: string; customerName: string; status: string; currency: string;
  priceMinor: string; billedMinor: string; earnedMinor: string;
  positionMinor: string; contractAssetMinor: string; contractLiabilityMinor: string;
  unearnedMinor: string;
  obligations: Obligation[];
}
interface Register {
  contracts: Contract[];
  totals: { priceMinor: string; billedMinor: string; earnedMinor: string; unearnedMinor: string };
  reconciliation: {
    registerAssetMinor: string; ledgerAssetMinor: string; assetDifferenceMinor: string;
    registerLiabilityMinor: string; ledgerLiabilityMinor: string; liabilityDifferenceMinor: string;
    pendingAssetMinor: string; pendingLiabilityMinor: string;
    agrees: boolean; explained: boolean;
  };
}

const today = () => new Date().toISOString().slice(0, 10);
const pct = (bps: number) => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`;

export default function RevenuePage() {
  const entityId = useEntityId();
  const ask = useAsk();
  const { data, error, loading, reload } = useLedgerQuery<Register>(
    entityId ? `/api/ledger/revenue?entityId=${entityId}` : null,
  );
  const [busy, setBusy] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [on, setOn] = React.useState(today);
  const [adding, setAdding] = React.useState(false);
  const [openCode, setOpenCode] = React.useState<string | null>(null);

  const act = async (label: string, body: Record<string, unknown>) => {
    setBusy(label); setErr(null); setMsg(null);
    try {
      const r = await api<Record<string, unknown>>("/api/ledger/revenue", {
        method: "POST", body: JSON.stringify({ entityId, ...body }),
      });
      reload();
      return r;
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "That did not work.");
      return null;
    } finally {
      setBusy(null);
    }
  };

  const runAll = async () => {
    const r = await act("runAll", { action: "runAll", on });
    if (!r) return;
    const n = Number(r.postedCount);
    setMsg(
      n === 0
        ? `Nothing to move as at ${on} — every contract is already presented correctly.`
        : `Recognised across ${n} contract${n === 1 ? "" : "s"} as at ${on}, moving ${toInput(String(r.revenueMinor))} of revenue.`,
    );
  };

  /**
   * A variation order — the ordinary event in a construction or services
   * contract, and until now impossible from this screen.
   *
   * `recordBilling` refuses anything past the original price and tells the
   * reader to "modify the contract first", which was an instruction with no
   * control behind it. IFRS 15.21: a modification that is not a separate
   * contract reallocates the price over what remains and catches revenue up in
   * this period rather than restating an earlier one.
   */
  const modify = async (c: Contract, priceMinor: string) => {
    const r = await act(`modify:${c.code}`, { action: "modify", code: c.code, priceMinor });
    if (!r) return;
    setMsg(
      `${c.code} now has a transaction price of ${fmtMinor(priceMinor, c.currency, { zero: "zero" })}. It has been ` +
        `reallocated across the obligations on their standalone selling prices, and what each has earned is ` +
        `recomputed against its new allocation — a half-finished obligation has earned half of what it is now ` +
        `allocated, not half of what it used to be. Recognise to move the difference.`,
    );
  };

  const cancel = async (c: Contract) => {
    const answer = await ask({
      title: `Cancel ${c.code}?`,
      detail:
        `Revenue already earned stays earned — the work was done — so this freezes the contract where it stands ` +
        `rather than unwinding it. Nothing further is recognised and nothing more can be billed against it. ` +
        `Anything owed back to the customer is a credit note, which is a document rather than a change to what ` +
        `this contract measured.`,
      confirmLabel: "Cancel the contract",
      cancelLabel: "Leave it active",
      destructive: true,
    });
    if (answer === null) return;
    const r = await act(`cancel:${c.code}`, { action: "cancel", code: c.code });
    if (!r) return;
    setMsg(
      `${c.code} is cancelled. The ${fmtMinor(c.earnedMinor, c.currency, { zero: "zero" })} earned to date stays ` +
        `recognised; only the backlog stops.`,
    );
  };

  if (!entityId) return <Loading label="Choosing an entity…" />;

  const rec = data?.reconciliation;

  return (
    <>
      <PageHead
        title="Revenue recognition"
        sub={
          "IFRS 15 recognises revenue when a promise is kept, not when an invoice is sent. Each contract's price is " +
          "allocated across what was promised, and the difference between what has been billed and what has been " +
          "earned is carried as a contract asset or a contract liability. Nothing here touches receivables or tax — " +
          "an invoice remains an invoice; this only moves revenue into the period it belongs to."
        }
        actions={
          <>
            <label className="flex items-center gap-1.5">
              <span className="sw-label">As at</span>
              <input
                type="date"
                className="sw-input"
                style={{ width: "10rem" }}
                value={on}
                onChange={(e) => setOn(e.target.value)}
                aria-label="Date to recognise as at"
              />
            </label>
            <button
              type="button"
              className="sw-btn sw-btn-primary"
              onClick={runAll}
              aria-disabled={busy === "runAll" || undefined}
              disabled={busy === "runAll"}
              data-testid="run-recognition"
            >
              {busy === "runAll" ? "Running…" : "Recognise"}
            </button>
            <button type="button" className="sw-btn" onClick={() => setAdding((a) => !a)} data-testid="toggle-add-contract">
              {adding ? "Cancel" : "Add contract"}
            </button>
          </>
        }
      />

      {err && <ErrorNote>{err}</ErrorNote>}
      {msg && <div className="sw-note mb-3" role="status" data-testid="revenue-result">{msg}</div>}
      {error && <ErrorNote>{error}</ErrorNote>}

      {adding && (
        <AddContract
          busy={busy === "create"}
          onAdd={async (contract) => {
            const r = await act("create", { action: "create", contract });
            if (r) {
              setAdding(false);
              setMsg(`Recorded ${contract.code}. The price is allocated across its obligations; nothing reaches the ledger until it is recognised.`);
            }
          }}
        />
      )}

      {loading && !data && <Loading />}

      {data && rec && (
        <>
          <Panel className="mb-4 p-4">
            <div className="sw-label">Register against the ledger</div>
            <table className="sw-table mt-3" style={{ maxWidth: "48rem" }}>
              <caption className="sr-only">Contract assets and liabilities against accounts 1310 and 2310</caption>
              <thead>
                <tr>
                  <th />
                  <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Register</th>
                  <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Ledger</th>
                  <th style={{ width: "9rem" }} />
                </tr>
              </thead>
              <tbody>
                <Compare
                  label="Contract assets" account="1310"
                  a={rec.registerAssetMinor} b={rec.ledgerAssetMinor}
                  pending={rec.pendingAssetMinor}
                />
                <Compare
                  label="Contract liabilities" account="2310"
                  a={rec.registerLiabilityMinor} b={rec.ledgerLiabilityMinor}
                  pending={rec.pendingLiabilityMinor}
                />
              </tbody>
            </table>
            {rec.agrees ? (
              <p className="sw-sub mt-2 max-w-[70ch]">
                The register and the ledger agree. Every contract asset and contract liability on the balance
                sheet is supported by a contract on this page.
              </p>
            ) : rec.explained ? (
              <p className="sw-sub mt-2 max-w-[70ch]" data-testid="revenue-pending">
                The register is ahead of the ledger by exactly what has been delivered since the last run.
                Recognise as at a date above and the two will agree.
              </p>
            ) : (
              <p className="sw-sub mt-2 max-w-[70ch]" style={{ color: "var(--sw-neg)" }} data-testid="revenue-unexplained">
                The register and the ledger differ by more than the work waiting to be recognised. That is a
                finding, not a display problem — 1310 or 2310 has most likely been posted to by hand.
              </p>
            )}
          </Panel>

          <Panel className="mb-4 p-4">
            <div className="sw-label">Across every contract</div>
            <dl className="mt-3 grid gap-4 sm:grid-cols-4">
              <Stat label="Transaction price" minor={data.totals.priceMinor} />
              <Stat label="Billed" minor={data.totals.billedMinor} />
              <Stat label="Earned" minor={data.totals.earnedMinor} />
              <Stat label="Still to earn" minor={data.totals.unearnedMinor} hint="The backlog — promises not yet kept." />
            </dl>
          </Panel>

          {data.contracts.length === 0 ? (
            <Empty>No revenue contracts recorded yet.</Empty>
          ) : (
            <Panel className="overflow-hidden">
              <div className="sw-scroll">
                <table className="sw-table">
                  <caption className="sr-only">Revenue contracts</caption>
                  <thead>
                    <tr>
                      <th style={{ width: "7rem" }}>Code</th>
                      <th>Customer</th>
                      <th style={{ width: "7rem" }}>Status</th>
                      <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Price</th>
                      <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Billed</th>
                      <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Earned</th>
                      <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Position</th>
                      <th style={{ width: "5rem" }} />
                    </tr>
                  </thead>
                  <tbody data-testid="contract-rows">
                    {data.contracts.map((c) => (
                      <React.Fragment key={c.code}>
                        <tr>
                          <td className="sw-code">{c.code}</td>
                          <td className="max-w-0 truncate">{c.customerName}</td>
                          <td><StatusChip status={c.status} /></td>
                          <td className="sw-num"><Figure minor={c.priceMinor} colour={false} /></td>
                          <td className="sw-num"><Figure minor={c.billedMinor} colour={false} /></td>
                          <td className="sw-num"><Figure minor={c.earnedMinor} colour={false} /></td>
                          <td className="sw-num" title={positionWord(c)}>
                            <Figure minor={c.positionMinor} zero="dash" />
                          </td>
                          <td>
                            <button
                              type="button"
                              className="sw-link-btn"
                              aria-expanded={openCode === c.code}
                              onClick={() => setOpenCode(openCode === c.code ? null : c.code)}
                            >
                              {openCode === c.code ? "Hide" : "Open"}
                            </button>
                          </td>
                        </tr>
                        {openCode === c.code && (
                          <tr>
                            <td colSpan={8} style={{ background: "var(--sw-ground)" }}>
                              <Obligations
                                contract={c}
                                busy={busy}
                                onSatisfy={async (seq) => {
                                  const r = await act(`satisfy:${c.code}:${seq}`, { action: "satisfy", code: c.code, seq, on });
                                  if (r) setMsg(`Obligation ${seq} on ${c.code} was satisfied on ${on}. Recognise to put it on the ledger.`);
                                }}
                                onProgress={async (seq, bps) => {
                                  const r = await act(`progress:${c.code}:${seq}`, { action: "progress", code: c.code, seq, progressBps: bps });
                                  if (r) setMsg(`Obligation ${seq} on ${c.code} is ${pct(bps)} complete.`);
                                }}
                                onBill={async (amountMinor) => {
                                  const r = await act(`bill:${c.code}`, { action: "bill", code: c.code, amountMinor });
                                  if (r) setMsg(`Recorded ${toInput(amountMinor)} billed on ${c.code}.`);
                                }}
                                onRun={async () => {
                                  const r = await act(`run:${c.code}`, { action: "run", code: c.code, on });
                                  if (r) setMsg(`${c.code}: ${String(r.note)}`);
                                }}
                                onModify={(priceMinor) => modify(c, priceMinor)}
                                onCancel={() => cancel(c)}
                              />
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          )}

          <p className="sw-sub mt-3 max-w-[75ch]">
            A positive position is a contract asset: work done that has not been invoiced. A negative one is a
            contract liability: money charged for work not yet done. Over the life of a contract the two cancel
            exactly, because this page never creates revenue — it only moves it into the right period.
          </p>
        </>
      )}
    </>
  );
}

function positionWord(c: Contract): string {
  if (BigInt(c.contractAssetMinor) > 0n) return "Contract asset — earned, not yet billed";
  if (BigInt(c.contractLiabilityMinor) > 0n) return "Contract liability — billed, not yet earned";
  return "Billing and delivery are level";
}

function Stat({ label, minor, hint }: { label: string; minor: string; hint?: string }) {
  return (
    <div>
      <dt className="sw-label">{label}</dt>
      <dd className="sw-num mt-1 text-lg"><Figure minor={minor} colour={false} /></dd>
      {hint && <p className="sw-sub mt-0.5">{hint}</p>}
    </div>
  );
}

function Compare({ label, account, a, b, pending }: {
  label: string; account: string; a: string; b: string; pending: string;
}) {
  const agrees = BigInt(a) === BigInt(b);
  const explained = BigInt(a) - BigInt(b) === BigInt(pending);
  return (
    <tr>
      <th scope="row" style={{ textAlign: "start", fontWeight: 400 }}>
        {label} <span className="sw-code sw-sub">{account}</span>
      </th>
      <td className="sw-num"><Figure minor={a} colour={false} /></td>
      <td className="sw-num"><Figure minor={b} colour={false} /></td>
      <td>
        {agrees ? (
          <span className="sw-chip sw-chip-ok">agrees</span>
        ) : explained ? (
          <span className="sw-chip">to recognise</span>
        ) : (
          <span className="sw-chip sw-chip-bad">differs</span>
        )}
      </td>
    </tr>
  );
}

function Obligations({ contract, busy, onSatisfy, onProgress, onBill, onRun, onModify, onCancel }: {
  contract: Contract;
  busy: string | null;
  onSatisfy: (seq: number) => void;
  onProgress: (seq: number, bps: number) => void;
  onBill: (amountMinor: string) => void;
  onRun: () => void;
  onModify: (priceMinor: string) => void;
  onCancel: () => void;
}) {
  const [bill, setBill] = React.useState("");
  const [billErr, setBillErr] = React.useState<string | null>(null);
  const [price, setPrice] = React.useState(() => toInput(contract.priceMinor, contract.currency));
  const [priceErr, setPriceErr] = React.useState<string | null>(null);
  const live = contract.status === "active";

  return (
    <div className="p-3">
      <table className="sw-table" style={{ maxWidth: "56rem" }}>
        <caption className="sr-only">Performance obligations on {contract.code}</caption>
        <thead>
          <tr>
            <th style={{ width: "3rem" }}>#</th>
            <th>Promised</th>
            <th style={{ width: "8rem" }}>Satisfied</th>
            <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Standalone</th>
            <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Allocated</th>
            <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Earned</th>
            <th style={{ width: "13rem" }} />
          </tr>
        </thead>
        <tbody>
          {contract.obligations.map((o) => (
            <tr key={o.seq}>
              <td className="sw-num">{o.seq}</td>
              <td className="max-w-0 truncate">{o.description}</td>
              <td className="sw-sub">{o.timing === "OVER_TIME" ? "over time" : "at a point"}</td>
              <td className="sw-num"><Figure minor={o.standalonePriceMinor} colour={false} /></td>
              <td className="sw-num"><Figure minor={o.allocatedMinor} colour={false} /></td>
              <td className="sw-num"><Figure minor={o.recognisedMinor} colour={false} /></td>
              <td>
                {!live ? (
                  <span className="sw-sub">—</span>
                ) : o.timing === "POINT_IN_TIME" ? (
                  o.satisfiedOn ? (
                    <span className="sw-sub">done {o.satisfiedOn.slice(0, 10)}</span>
                  ) : (
                    <button
                      type="button"
                      className="sw-btn sw-btn-sm"
                      onClick={() => onSatisfy(o.seq)}
                      disabled={busy === `satisfy:${contract.code}:${o.seq}`}
                    >
                      Mark delivered
                    </button>
                  )
                ) : (
                  <label className="flex items-center gap-1.5">
                    <span className="sr-only">{`Progress on obligation ${o.seq}, in percent`}</span>
                    <input
                      type="number"
                      className="sw-input sw-input-sm"
                      style={{ width: "5rem" }}
                      min={0}
                      max={100}
                      step={1}
                      defaultValue={o.progressBps / 100}
                      onBlur={(e) => {
                        const v = Math.round(Number(e.target.value) * 100);
                        if (Number.isFinite(v) && v !== o.progressBps) onProgress(o.seq, Math.max(0, Math.min(10000, v)));
                      }}
                    />
                    <span className="sw-sub">% complete</span>
                  </label>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="flex items-center gap-1.5">
          <span className="sw-label">Record billed</span>
          <input
            className="sw-input sw-num"
            style={{ width: "9rem" }}
            value={bill}
            onChange={(e) => { setBill(e.target.value); setBillErr(null); }}
            placeholder="0.00"
            aria-label={`Amount billed on ${contract.code}, net of tax`}
            aria-invalid={billErr ? true : undefined}
          />
        </label>
        <button
          type="button"
          className="sw-btn sw-btn-sm"
          disabled={busy === `bill:${contract.code}` || !live}
          onClick={() => {
            const v = parseAmount(bill, contract.currency);
            if (v === null) { setBillErr("That is not an amount I can read."); return; }
            onBill(v.toString());
            setBill("");
          }}
        >
          Record
        </button>
        <button
          type="button"
          className="sw-btn sw-btn-sm sw-btn-primary"
          disabled={busy === `run:${contract.code}`}
          onClick={onRun}
          data-testid={`run-${contract.code}`}
        >
          Recognise this contract
        </button>
        {billErr && <span className="sw-error" role="alert">{billErr}</span>}
      </div>

      <p className="sw-sub mt-2 max-w-[70ch]">
        Billed is net of tax, because tax is not revenue. The invoice itself already reached the ledger through
        receivables — recording it here only tells the contract how much of its price has been charged.
      </p>

      {/* A variation order and an abandoned contract: the two things that
          happen to a live contract and could not be recorded from here. */}
      <div className="mt-3 flex flex-wrap items-end gap-3" style={{ borderTop: "1px solid var(--sw-line)", paddingTop: "0.75rem" }}>
        <label className="flex items-center gap-1.5">
          <span className="sw-label">Transaction price</span>
          <input
            className="sw-input sw-num"
            style={{ width: "10rem" }}
            value={price}
            onChange={(e) => { setPrice(e.target.value); setPriceErr(null); }}
            aria-label={`Transaction price on ${contract.code}`}
            aria-invalid={priceErr ? true : undefined}
            disabled={!live}
          />
        </label>
        <button
          type="button"
          className="sw-btn sw-btn-sm"
          disabled={!live || busy === `modify:${contract.code}`}
          aria-disabled={!live || busy === `modify:${contract.code}` || undefined}
          data-testid={`modify-${contract.code}`}
          onClick={() => {
            const v = parseAmount(price, contract.currency);
            if (v === null) { setPriceErr("That is not an amount I can read."); return; }
            if (v <= 0n) { setPriceErr("A modification cannot take the price to nil — cancel the contract instead."); return; }
            if (v.toString() === contract.priceMinor) { setPriceErr("That is the price it already has."); return; }
            onModify(v.toString());
          }}
        >
          Modify
        </button>
        <button
          type="button"
          className="sw-btn sw-btn-sm sw-btn-danger"
          disabled={!live || busy === `cancel:${contract.code}`}
          aria-disabled={!live || busy === `cancel:${contract.code}` || undefined}
          data-testid={`cancel-${contract.code}`}
          onClick={onCancel}
        >
          Cancel contract
        </button>
        {priceErr && <span className="sw-error" role="alert">{priceErr}</span>}
      </div>

      <p className="sw-sub mt-2 max-w-[75ch]">
        {live ? (
          <>
            A variation order changes the price, and the change is spread across the obligations on their standalone
            selling prices — IFRS 15.21, for a modification that is not a separate contract. Billing is refused above
            the price, so a variation has to be recorded here before the invoice for it can be.
          </>
        ) : (
          <>This contract is {contract.status}, so nothing further is recognised and nothing more can be billed against it.</>
        )}
      </p>
    </div>
  );
}

interface DraftObligation { description: string; standalone: string; timing: string }

function AddContract({ busy, onAdd }: {
  busy: boolean;
  onAdd: (c: {
    code: string; customerName: string; signedOn: string; priceMinor: string;
    revenueAccount: string;
    obligations: { description: string; standalonePriceMinor: string; timing: string }[];
  }) => void;
}) {
  const [code, setCode] = React.useState("");
  const [customer, setCustomer] = React.useState("");
  const [signedOn, setSignedOn] = React.useState(today);
  const [price, setPrice] = React.useState("");
  const [account, setAccount] = React.useState("4100");
  const [rows, setRows] = React.useState<DraftObligation[]>([
    { description: "", standalone: "", timing: "POINT_IN_TIME" },
    { description: "", standalone: "", timing: "OVER_TIME" },
  ]);
  const [err, setErr] = React.useState<string | null>(null);

  const set = (i: number, patch: Partial<DraftObligation>) =>
    setRows((rs) => rs.map((r, j) => (i === j ? { ...r, ...patch } : r)));

  const priceMinor = parseAmount(price, "AED");
  const filled = rows.filter((r) => r.description.trim() && r.standalone.trim());
  const standaloneTotal = filled.reduce((a, r) => a + (parseAmount(r.standalone, "AED") ?? 0n), 0n);

  return (
    <Panel className="mb-4 p-4">
      <div className="sw-label">A new contract</div>
      <div className="mt-3 grid gap-3 sm:grid-cols-5">
        <Field label="Code"><input className="sw-input" value={code} onChange={(e) => setCode(e.target.value)} /></Field>
        <Field label="Customer"><input className="sw-input" value={customer} onChange={(e) => setCustomer(e.target.value)} /></Field>
        <Field label="Signed"><input type="date" className="sw-input" value={signedOn} onChange={(e) => setSignedOn(e.target.value)} /></Field>
        <Field label="Transaction price">
          <input className="sw-input sw-num" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="0.00" />
        </Field>
        <Field label="Revenue account">
          <select className="sw-select" value={account} onChange={(e) => setAccount(e.target.value)}>
            <option value="4000">4000 Sales — goods</option>
            <option value="4100">4100 Sales — services</option>
            <option value="4200">4200 Sales — exports</option>
          </select>
        </Field>
      </div>

      <div className="sw-label mt-4">What was promised</div>
      <table className="sw-table mt-2" style={{ maxWidth: "52rem" }}>
        <caption className="sr-only">Performance obligations and their standalone selling prices</caption>
        <thead>
          <tr>
            <th style={{ width: "3rem" }}>#</th>
            <th>Promised</th>
            <th style={{ width: "11rem" }}>Satisfied</th>
            <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Standalone price</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td className="sw-num">{i + 1}</td>
              <td>
                <input
                  className="sw-input" style={{ width: "100%" }}
                  value={r.description} onChange={(e) => set(i, { description: e.target.value })}
                  aria-label={`Obligation ${i + 1} description`}
                />
              </td>
              <td>
                <select
                  className="sw-select" value={r.timing} onChange={(e) => set(i, { timing: e.target.value })}
                  aria-label={`Obligation ${i + 1} timing`}
                >
                  <option value="POINT_IN_TIME">at a point in time</option>
                  <option value="OVER_TIME">over time</option>
                </select>
              </td>
              <td>
                <input
                  className="sw-input sw-num" style={{ width: "100%" }}
                  value={r.standalone} onChange={(e) => set(i, { standalone: e.target.value })}
                  placeholder="0.00" aria-label={`Obligation ${i + 1} standalone selling price`}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="mt-2 flex flex-wrap items-center gap-3">
        <button type="button" className="sw-btn sw-btn-sm" onClick={() => setRows((rs) => [...rs, { description: "", standalone: "", timing: "POINT_IN_TIME" }])}>
          Add a promise
        </button>
        {standaloneTotal > 0n && priceMinor !== null && standaloneTotal !== priceMinor && (
          <span className="sw-sub">
            Standalone prices come to <Figure minor={standaloneTotal.toString()} colour={false} />, which is fine —
            the price is allocated in proportion, not matched to them.
          </span>
        )}
      </div>

      {err && <div className="sw-error mt-2" role="alert">{err}</div>}

      <div className="mt-3 flex gap-2">
        <button
          type="button"
          className="sw-btn sw-btn-primary"
          disabled={busy}
          data-testid="save-contract"
          onClick={() => {
            if (!code.trim() || !customer.trim()) { setErr("A contract needs a code and the customer it is with."); return; }
            if (priceMinor === null || priceMinor <= 0n) { setErr("The transaction price has to be an amount above nil."); return; }
            if (!filled.length) { setErr("A contract needs at least one promise — what did we agree to deliver?"); return; }
            const obligations = filled.map((r) => ({
              description: r.description.trim(),
              standalonePriceMinor: (parseAmount(r.standalone, "AED") ?? 0n).toString(),
              timing: r.timing,
            }));
            if (obligations.some((o) => BigInt(o.standalonePriceMinor) <= 0n)) {
              setErr("Every promise needs a standalone selling price above nil — that is what the allocation is in proportion to.");
              return;
            }
            setErr(null);
            onAdd({
              code: code.trim(), customerName: customer.trim(), signedOn,
              priceMinor: priceMinor.toString(), revenueAccount: account, obligations,
            });
          }}
        >
          {busy ? "Saving…" : "Record the contract"}
        </button>
      </div>
    </Panel>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="sw-label">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}
