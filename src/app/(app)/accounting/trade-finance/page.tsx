"use client";

import * as React from "react";
import { api, ApiError, useEntityId, useLedgerQuery } from "@/components/ledger/use-ledger";
import { Figure, PageHead, Panel, ErrorNote, Loading, Empty, StatusChip } from "@/components/ledger/primitives";
import { useAsk } from "@/components/ledger/ask";
import { fmtMinor, parseAmount } from "@/lib/ledger/format";

interface Event { kind: string; happenedOn: string; amountMinor: string; entryId: string | null; memo: string | null }
interface Facility {
  reference: string; kind: string; kindLabel: string; bank: string; beneficiary: string;
  currency: string; amountMinor: string; marginMinor: string; commissionMinor: string;
  drawnMinor: string; availableMinor: string; owedToBankMinor: string;
  issuedOn: string; expiresOn: string; daysToExpiry: number; expired: boolean;
  status: string; ownExposure: boolean; notes: string | null; events: Event[];
}
interface Register {
  asOf: string;
  since: string;
  truncated: boolean;
  listed: number;
  facilities: Facility[];
  lapsed: string[];
  lapsedCount: number;
  kinds: Record<string, string>;
}
interface Note {
  asOf: string;
  byKind: { kind: string; label: string; count: number; facedMinor: string; drawnMinor: string; contingentMinor: string }[];
  totalFacedMinor: string;
  totalDrawnMinor: string;
  totalContingentMinor: string;
  heldInFavourMinor: string;
  restrictedCash: { marginMinor: string; ledgerMinor: string; agrees: boolean; differenceMinor: string };
  expiringWithin90Days: { reference: string; kind: string; expiresOn: string; contingentMinor: string }[];
  statement: string;
  basis: string;
}

const today = () => new Date().toISOString().slice(0, 10);

export default function TradeFinancePage() {
  const entityId = useEntityId();
  const ask = useAsk();
  const [asOf, setAsOf] = React.useState(today);
  const [tab, setTab] = React.useState<"register" | "note">("register");
  const [open, setOpen] = React.useState<string | null>(null);
  const [closing, setClosing] = React.useState<string | null>(null);
  const [adding, setAdding] = React.useState(false);
  const [status, setStatus] = React.useState("");

  const q = new URLSearchParams({ entityId: entityId ?? "", asOf });
  if (status) q.set("status", status);
  const { data, error, loading, reload } = useLedgerQuery<Register>(
    entityId ? `/api/ledger/trade-finance?${q.toString()}` : null,
    [asOf, status],
  );
  const note = useLedgerQuery<Note>(
    entityId && tab === "note" ? `/api/ledger/trade-finance?entityId=${entityId}&view=note&asOf=${asOf}` : null,
    [tab, asOf],
  );

  const [busy, setBusy] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [err, setErr] = React.useState<string | null>(null);

  const act = async (label: string, body: Record<string, unknown>) => {
    setBusy(label); setErr(null); setMsg(null);
    try {
      const r = await api<Record<string, unknown>>("/api/ledger/trade-finance", {
        method: "POST", body: JSON.stringify({ entityId, ...body }),
      });
      reload();
      if (tab === "note") note.reload();
      return r;
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "That did not work.");
      return null;
    } finally {
      setBusy(null);
    }
  };

  if (!entityId) return <Loading label="Choosing an entity…" />;

  return (
    <>
      <PageHead
        title="Trade finance"
        sub={
          "Letters of credit, bank guarantees and trust receipts. A guarantee that has not been called is not a " +
          "liability — the obligation depends on a future event outside the entity's control, which IAS 37.27 says " +
          "is disclosed rather than provided for. What is posted is the margin the bank holds and the commission " +
          "it charges, and the margin is not cash: it cannot be spent while the facility is open."
        }
        actions={
          <>
            <label className="flex items-center gap-1.5">
              <span className="sw-label">As at</span>
              <input type="date" className="sw-input" style={{ width: "10rem" }} value={asOf}
                onChange={(e) => setAsOf(e.target.value)} aria-label="Date to draw the register at" />
            </label>
            <button type="button" className="sw-btn" onClick={() => setAdding((a) => !a)} data-testid="toggle-add-facility">
              {adding ? "Cancel" : "Open a facility"}
            </button>
          </>
        }
      />

      {err && <ErrorNote>{err}</ErrorNote>}
      {msg && <div className="sw-note mb-3" role="status" data-testid="tf-result">{msg}</div>}
      {error && <ErrorNote>{error}</ErrorNote>}

      {adding && data && (
        <NewFacilityForm
          kinds={data.kinds}
          busy={busy === "issue"}
          onIssue={async (facility) => {
            const r = await act("issue", { action: "issue", facility });
            if (r) { setAdding(false); setMsg(String(r.note)); }
          }}
        />
      )}

      <nav className="sw-tabs mb-4" aria-label="What to show">
        <button type="button" className="sw-tab" aria-current={tab === "register" ? "page" : undefined}
          onClick={() => setTab("register")}>Register</button>
        <button type="button" className="sw-tab" aria-current={tab === "note" ? "page" : undefined}
          onClick={() => setTab("note")}>Contingent liabilities note</button>
      </nav>

      {tab === "register" && (
        <>
          {loading && !data && <Loading />}
          {data && (
            <>
              {data.lapsed.length > 0 && (
                <Panel className="mb-4 p-4">
                  <div className="sw-label">Past expiry and not closed</div>
                  <p className="sw-sub mt-1 max-w-[75ch]" data-testid="tf-lapsed">
                    {data.lapsed.join(", ")}
                    {data.lapsedCount > data.lapsed.length && ` and ${data.lapsedCount - data.lapsed.length} more`}.
                    The bank is still holding the margin and the register still shows a facility that has lapsed —
                    the first overstates cash and the second leaves a line on a screen that no longer means anything.
                    Closing one records whether it ran out or was cancelled, and brings the margin back.
                  </p>
                </Panel>
              )}

              <div className="mb-3">
                <label className="flex items-center gap-1.5">
                  <span className="sw-label">Showing</span>
                  <select className="sw-select" style={{ width: "12rem" }} value={status}
                    onChange={(e) => { setStatus(e.target.value); setOpen(null); setClosing(null); }}
                    aria-label="Which facilities to show">
                    <option value="">everything still listed</option>
                    <option value="issued">open, undrawn</option>
                    <option value="drawn">drawn</option>
                    <option value="expired">expired</option>
                    <option value="cancelled">cancelled</option>
                  </select>
                </label>
              </div>

              {data.truncated && (
                <p className="sw-sub mb-3 max-w-[75ch]" role="status" data-testid="tf-truncated">
                  {data.listed} facilities are listed, soonest expiry first. Everything still open is here whatever
                  its age; what is closed is listed back to {data.since}.
                </p>
              )}

              {data.facilities.length === 0 ? (
                <Empty>
                  {status
                    ? `No facility in that state, listed from ${data.since}.`
                    : "No facility has been recorded."}
                </Empty>
              ) : (
                <Panel className="overflow-hidden">
                  <div className="sw-scroll">
                    <table className="sw-table">
                      <caption className="sr-only">Trade finance facilities</caption>
                      <thead>
                        <tr>
                          <th style={{ width: "9rem" }}>Reference</th>
                          <th style={{ width: "12rem" }}>Kind</th>
                          <th>Bank and beneficiary</th>
                          <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Face</th>
                          <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Margin</th>
                          <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Drawn</th>
                          <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Owed to bank</th>
                          <th style={{ width: "8rem" }}>Expires</th>
                          <th style={{ width: "6rem" }}>Status</th>
                          <th style={{ width: "11rem" }} />
                        </tr>
                      </thead>
                      <tbody data-testid="tf-rows">
                        {data.facilities.map((f) => (
                          <React.Fragment key={f.reference}>
                            <tr>
                              <td className="sw-code">{f.reference}</td>
                              <td>
                                {f.kindLabel}
                                {!f.ownExposure && <span className="sw-chip ml-1.5">held in our favour</span>}
                              </td>
                              <td className="max-w-0 truncate">
                                {f.bank}
                                <span className="sw-sub"> — {f.beneficiary}</span>
                              </td>
                              <td className="sw-num"><Figure minor={f.amountMinor} colour={false} /></td>
                              <td className="sw-num"><Figure minor={f.marginMinor} colour={false} /></td>
                              <td className="sw-num"><Figure minor={f.drawnMinor} colour={false} /></td>
                              <td className="sw-num"><Figure minor={f.owedToBankMinor} colour={false} /></td>
                              <td>
                                {f.expiresOn}
                                {f.expired && <span className="sw-chip sw-chip-bad ml-1.5">lapsed</span>}
                                {!f.expired && f.daysToExpiry <= 90 && f.daysToExpiry >= 0 && (
                                  <span className="sw-sub"> — {f.daysToExpiry}d</span>
                                )}
                              </td>
                              <td><StatusChip status={f.status} /></td>
                              <td>
                                {f.ownExposure && (f.status === "issued" || f.status === "drawn") && (
                                  <>
                                    <button type="button" className="sw-link-btn" disabled={busy === `draw:${f.reference}`}
                                      onClick={async () => {
                                        const left = fmtMinor(f.availableMinor, f.currency, { zero: "zero" });
                                        const amt = await ask({
                                          title: `How much was drawn under ${f.reference}?`,
                                          detail:
                                            (f.kind === "BANK_GUARANTEE"
                                              ? `The guarantee has been called, and a called guarantee is an expense rather than a ` +
                                                `payable: the drawing debits 6900 and credits trust receipts 2470, because the entity ` +
                                                `has paid for somebody else's failure to perform and gets nothing for the money. `
                                              : `${f.bank} has paid ${f.beneficiary}, so the drawing debits trade payables 2000 and ` +
                                                `credits trust receipts 2470 — the same debt, owed to the bank instead of the supplier, ` +
                                                `bearing interest from here and not gone away. `) +
                                            (f.expired
                                              ? `${f.reference} ran out on ${f.expiresOn} and is already out of the contingent-liability ` +
                                                `note — nobody can call a credit that has expired — so this posts against a facility ` +
                                                `the disclosure has let go. Record it only if the bank really did pay out. `
                                              : `The contingent liability disclosed for ${f.reference} falls by the same amount, because ` +
                                                `that much of the promise has stopped being contingent. `) +
                                            `${left} of the face is still undrawn and this comes off that; more than the face is refused.`,
                                          reason: {
                                            label: `Amount drawn, ${f.currency}`,
                                            placeholder: left,
                                            minLength: 1,
                                            single: true,
                                            hint: "Arithmetic is fine — 1200/3, or (450+80)*1.05 — and it is rounded to the minor unit.",
                                          },
                                          confirmLabel: "Record the drawing",
                                        });
                                        if (amt === null) return;
                                        const m = parseAmount(amt, f.currency);
                                        if (m === null) { setErr("That is not an amount I can read."); return; }
                                        const r = await act(`draw:${f.reference}`, {
                                          action: "draw", reference: f.reference, amountMinor: m.toString(), on: asOf,
                                        });
                                        if (r) setMsg(String(r.note));
                                      }}>
                                      drawn
                                    </button>
                                    {BigInt(f.owedToBankMinor) > 0n && (
                                      <>
                                        {" "}
                                        <button type="button" className="sw-link-btn" disabled={busy === `settle:${f.reference}`}
                                          onClick={async () => {
                                            const r = await act(`settle:${f.reference}`, {
                                              action: "settle", reference: f.reference,
                                              amountMinor: f.owedToBankMinor, on: asOf,
                                            });
                                            if (r) setMsg(`${f.reference} repaid. Nothing is owed to ${f.bank} under it.`);
                                          }}>
                                          repay
                                        </button>
                                      </>
                                    )}
                                    {" "}
                                    <button type="button" className="sw-link-btn"
                                      aria-expanded={closing === f.reference}
                                      onClick={() => {
                                        setClosing(closing === f.reference ? null : f.reference);
                                        setOpen(null);
                                      }}>
                                      close
                                    </button>
                                  </>
                                )}
                                {f.events.length > 0 && (
                                  <>
                                    {" "}
                                    <button type="button" className="sw-link-btn" aria-expanded={open === f.reference}
                                      onClick={() => setOpen(open === f.reference ? null : f.reference)}>
                                      {open === f.reference ? "hide" : "history"}
                                    </button>
                                  </>
                                )}
                              </td>
                            </tr>
                            {closing === f.reference && (
                              <tr>
                                <td colSpan={10} style={{ background: "var(--sw-ground)" }}>
                                  <CloseFacility
                                    reference={f.reference}
                                    expiresOn={f.expiresOn}
                                    marginMinor={f.marginMinor}
                                    currency={f.currency}
                                    suggested={asOf}
                                    busy={busy === `close:${f.reference}`}
                                    onCancel={() => setClosing(null)}
                                    onClose={async (on, reason) => {
                                      const r = await act(`close:${f.reference}`, {
                                        action: "close", reference: f.reference, on, reason,
                                      });
                                      if (r) {
                                        setClosing(null);
                                        setMsg(
                                          reason === "cancel"
                                            ? `${f.reference} is recorded as cancelled on ${on}, not as expired, and ` +
                                              `the margin has come back.`
                                            : `${f.reference} is recorded as expired on ${on} and the margin has ` +
                                              `come back.`,
                                        );
                                      }
                                    }}
                                  />
                                </td>
                              </tr>
                            )}
                            {open === f.reference && (
                              <tr>
                                <td colSpan={10} style={{ background: "var(--sw-ground)" }}>
                                  <table className="sw-table" style={{ maxWidth: "50rem", margin: "0.5rem" }}>
                                    <caption className="sr-only">What happened to {f.reference}</caption>
                                    <thead>
                                      <tr>
                                        <th style={{ width: "7rem" }}>When</th>
                                        <th style={{ width: "7rem" }}>What</th>
                                        <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Amount</th>
                                        <th>Note</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {f.events.map((e, i) => (
                                        <tr key={`${e.kind}:${e.happenedOn}:${i}`}>
                                          <td>{e.happenedOn}</td>
                                          <td>{e.kind}</td>
                                          <td className="sw-num"><Figure minor={e.amountMinor} colour={false} /></td>
                                          <td className="sw-sub">{e.memo ?? (e.entryId ? "posted" : "not posted")}</td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
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
                An export credit is issued by the buyer&rsquo;s bank in the entity&rsquo;s favour. It is security the
                entity holds rather than a promise it has made, so it is kept out of the contingent liabilities —
                counting it would report the entity as exposed to its own customer twice, once in receivables and
                once here.
              </p>
            </>
          )}
        </>
      )}

      {tab === "note" && (
        <>
          {note.error && <ErrorNote>{note.error}</ErrorNote>}
          {note.loading && !note.data && <Loading />}
          {note.data && (
            <>
              <Panel className="mb-4 p-4">
                <dl className="grid gap-4 sm:grid-cols-3">
                  <div>
                    <dt className="sw-label">Given, at face</dt>
                    <dd className="sw-num mt-1 text-lg"><Figure minor={note.data.totalFacedMinor} colour={false} /></dd>
                  </div>
                  <div>
                    <dt className="sw-label">Already called</dt>
                    <dd className="sw-num mt-1 text-lg"><Figure minor={note.data.totalDrawnMinor} colour={false} /></dd>
                    <p className="sw-sub mt-0.5">On the balance sheet. It stopped being contingent when it was called.</p>
                  </div>
                  <div>
                    <dt className="sw-label">Contingent</dt>
                    <dd className="sw-num mt-1 text-lg" data-testid="tf-contingent">
                      <Figure minor={note.data.totalContingentMinor} colour={false} />
                    </dd>
                    <p className="sw-sub mt-0.5">Disclosed, not recognised.</p>
                  </div>
                </dl>
                <p className="sw-sub mt-3 max-w-[75ch]">{note.data.statement}</p>
                <p className="sw-sub mt-1">Basis: {note.data.basis}.</p>
              </Panel>

              {note.data.byKind.length > 0 && (
                <Panel className="mb-4 overflow-hidden">
                  <div className="sw-scroll">
                    <table className="sw-table">
                      <caption className="sr-only">Contingent liabilities by kind</caption>
                      <thead>
                        <tr>
                          <th>Kind</th>
                          <th className="sw-num" style={{ width: "5rem" }}>Number</th>
                          <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Face</th>
                          <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Called</th>
                          <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Contingent</th>
                        </tr>
                      </thead>
                      <tbody data-testid="tf-note-rows">
                        {note.data.byKind.map((k) => (
                          <tr key={k.kind}>
                            <td>{k.label}</td>
                            <td className="sw-num">{k.count}</td>
                            <td className="sw-num"><Figure minor={k.facedMinor} colour={false} /></td>
                            <td className="sw-num"><Figure minor={k.drawnMinor} colour={false} /></td>
                            <td className="sw-num"><Figure minor={k.contingentMinor} colour={false} /></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Panel>
              )}

              <Panel className="mb-4 p-4">
                <div className="sw-label">Restricted cash — IAS 7.48</div>
                <dl className="mt-3 grid gap-4 sm:grid-cols-3">
                  <div>
                    <dt className="sw-sub">Margin the banks hold</dt>
                    <dd className="sw-num mt-1"><Figure minor={note.data.restrictedCash.marginMinor} colour={false} /></dd>
                  </div>
                  <div>
                    <dt className="sw-sub">What account 1255 carries</dt>
                    <dd className="sw-num mt-1"><Figure minor={note.data.restrictedCash.ledgerMinor} colour={false} /></dd>
                  </div>
                  <div>
                    <dt className="sw-sub">Do they agree?</dt>
                    <dd className="mt-1" role="status" data-testid="tf-margin-agrees">
                      {note.data.restrictedCash.agrees
                        ? <span className="sw-chip">yes</span>
                        : (
                          <>
                            <span className="sw-chip sw-chip-bad">no</span>{" "}
                            <span className="sw-num">
                              out by <Figure minor={note.data.restrictedCash.differenceMinor} />
                            </span>
                          </>
                        )}
                    </dd>
                  </div>
                </dl>
                <p className="sw-sub mt-3 max-w-[75ch]">
                  This money is an asset and it is not cash and cash equivalents: it cannot be spent while the
                  facility is open. Leaving it in the bank account would tell a reader the business has liquidity it
                  does not have — the same mistake as counting a post-dated cheque.
                </p>
              </Panel>

              {note.data.heldInFavourMinor !== "0" && (
                <Panel className="mb-4 p-4">
                  <div className="sw-label">Held in the entity&rsquo;s favour</div>
                  <div className="sw-num mt-1 text-lg"><Figure minor={note.data.heldInFavourMinor} colour={false} /></div>
                  <p className="sw-sub mt-1 max-w-[75ch]">
                    Security the entity holds rather than a promise it has made. It is not a contingent liability
                    and it is not an asset either — it is a comfort, and it is stated because a reader would
                    otherwise not know it exists.
                  </p>
                </Panel>
              )}

              {note.data.expiringWithin90Days.length > 0 && (
                <Panel className="p-4">
                  <div className="sw-label">Expiring within ninety days</div>
                  <table className="sw-table mt-2" style={{ maxWidth: "40rem" }}>
                    <caption className="sr-only">Facilities expiring soon</caption>
                    <thead>
                      <tr>
                        <th style={{ width: "10rem" }}>Reference</th>
                        <th style={{ width: "8rem" }}>Expires</th>
                        <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Contingent</th>
                      </tr>
                    </thead>
                    <tbody data-testid="tf-expiring">
                      {note.data.expiringWithin90Days.map((e) => (
                        <tr key={e.reference}>
                          <td className="sw-code">{e.reference}</td>
                          <td>{e.expiresOn}</td>
                          <td className="sw-num"><Figure minor={e.contingentMinor} colour={false} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="sw-sub mt-2 max-w-[75ch]">
                    A facility that lapses without being renewed leaves whatever it secured unsecured, and the
                    margin sitting with the bank until somebody asks for it back.
                  </p>
                </Panel>
              )}
            </>
          )}
        </>
      )}
    </>
  );
}

function NewFacilityForm({ kinds, busy, onIssue }: {
  kinds: Record<string, string>;
  busy: boolean;
  onIssue: (f: {
    reference: string; kind: string; bank: string; beneficiary: string; currency: string;
    amountMinor: string; marginMinor: string; commissionMinor: string;
    issuedOn: string; expiresOn: string; notes?: string;
  }) => void;
}) {
  const [reference, setReference] = React.useState("");
  const [kind, setKind] = React.useState("LC_IMPORT");
  const [bank, setBank] = React.useState("");
  const [beneficiary, setBeneficiary] = React.useState("");
  const [currency, setCurrency] = React.useState("AED");
  const [amount, setAmount] = React.useState("");
  const [margin, setMargin] = React.useState("");
  const [commission, setCommission] = React.useState("");
  const [issuedOn, setIssuedOn] = React.useState(today);
  const [expiresOn, setExpiresOn] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [err, setErr] = React.useState<string | null>(null);

  return (
    <Panel className="mb-4 p-4">
      <div className="sw-label">A new facility</div>
      <p className="sw-sub mt-1 max-w-[75ch]">
        The face amount reaches no account. Only the margin and the commission are posted — an obligation that
        depends on a future event outside the entity&rsquo;s control is disclosed, not recognised.
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-4">
        <label className="block">
          <span className="sw-label">Bank&rsquo;s reference</span>
          <input className="sw-input sw-code mt-1" value={reference} onChange={(e) => setReference(e.target.value)} />
        </label>
        <label className="block">
          <span className="sw-label">Kind</span>
          <select className="sw-select mt-1" value={kind} onChange={(e) => setKind(e.target.value)}>
            {Object.entries(kinds).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="sw-label">Bank</span>
          <input className="sw-input mt-1" value={bank} onChange={(e) => setBank(e.target.value)} />
        </label>
        <label className="block">
          <span className="sw-label">In favour of</span>
          <input className="sw-input mt-1" value={beneficiary} onChange={(e) => setBeneficiary(e.target.value)} />
        </label>
        <label className="block">
          <span className="sw-label">Currency</span>
          <input className="sw-input sw-code mt-1" value={currency}
            onChange={(e) => setCurrency(e.target.value.toUpperCase())} />
        </label>
        <label className="block">
          <span className="sw-label">Face amount</span>
          <input className="sw-input sw-num mt-1" value={amount} placeholder="0.00"
            onChange={(e) => setAmount(e.target.value)} />
        </label>
        <label className="block">
          <span className="sw-label">Cash margin</span>
          <input className="sw-input sw-num mt-1" value={margin} placeholder="0.00"
            onChange={(e) => setMargin(e.target.value)} />
          <span className="sw-sub">Restricted — an asset, not cash.</span>
        </label>
        <label className="block">
          <span className="sw-label">Commission</span>
          <input className="sw-input sw-num mt-1" value={commission} placeholder="0.00"
            onChange={(e) => setCommission(e.target.value)} />
        </label>
        <label className="block">
          <span className="sw-label">Issued</span>
          <input type="date" className="sw-input mt-1" value={issuedOn} onChange={(e) => setIssuedOn(e.target.value)} />
        </label>
        <label className="block">
          <span className="sw-label">Expires</span>
          <input type="date" className="sw-input mt-1" value={expiresOn} onChange={(e) => setExpiresOn(e.target.value)} />
        </label>
        <label className="block sm:col-span-2">
          <span className="sw-label">Note</span>
          <input className="sw-input mt-1" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="optional" />
        </label>
      </div>

      {err && <div className="sw-error mt-2" role="alert">{err}</div>}

      <div className="mt-3">
        <button type="button" className="sw-btn sw-btn-primary" disabled={busy} data-testid="save-facility"
          onClick={() => {
            const a = parseAmount(amount, currency);
            if (!reference.trim()) { setErr("A facility needs the bank's reference for it."); return; }
            if (!bank.trim() || !beneficiary.trim()) { setErr("Which bank, and in whose favour?"); return; }
            if (a === null || a <= 0n) { setErr("A facility for nothing is not a facility."); return; }
            if (!expiresOn) { setErr("When does it expire?"); return; }
            const m = margin.trim() ? parseAmount(margin, currency) : 0n;
            const c = commission.trim() ? parseAmount(commission, currency) : 0n;
            if (m === null || c === null) { setErr("The margin and the commission have to be amounts I can read."); return; }
            setErr(null);
            onIssue({
              reference: reference.trim(), kind, bank: bank.trim(), beneficiary: beneficiary.trim(),
              currency, amountMinor: a.toString(), marginMinor: m.toString(), commissionMinor: c.toString(),
              issuedOn, expiresOn, notes: notes.trim() || undefined,
            });
          }}>
          {busy ? "Recording…" : "Open the facility"}
        </button>
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------- closing a facility */

/**
 * A facility ends for one of two reasons, and which one it was has to be said.
 *
 * Recording a cancellation as an expiry leaves a row whose status says
 * "expired" against an expiry date still in the future, which is not a small
 * untidiness: it is the difference between a credit the bank let run out and
 * one the entity walked away from, and only one of those is a fact about the
 * entity's relationship with its bank.
 *
 * The margin comes back either way. The bank holds it against the promise
 * rather than against the drawing.
 */
function CloseFacility({ reference, expiresOn, marginMinor, currency, suggested, busy, onCancel, onClose }: {
  reference: string;
  expiresOn: string;
  marginMinor: string;
  currency: string;
  suggested: string;
  busy: boolean;
  onCancel: () => void;
  onClose: (on: string, reason: "expire" | "cancel") => void;
}) {
  const [on, setOn] = React.useState(suggested);
  // What it looks like from the dates, offered rather than assumed: a facility
  // closed before its expiry was almost always cancelled, and one closed after
  // it almost always just ran out.
  const [reason, setReason] = React.useState<"expire" | "cancel">(on < expiresOn ? "cancel" : "expire");

  return (
    <div className="p-3" style={{ maxWidth: "46rem" }}>
      <div className="sw-label">Closing {reference}</div>
      <div className="mt-2 flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="sw-label">Closed on</span>
          <input type="date" className="sw-input mt-1" style={{ width: "10rem" }} value={on}
            aria-label={`Date ${reference} was closed`}
            onChange={(e) => setOn(e.target.value)} />
        </label>
        <label className="block">
          <span className="sw-label">Because</span>
          <select className="sw-select mt-1" style={{ width: "18rem" }} value={reason}
            data-testid={`close-reason-${reference}`}
            aria-label={`Why ${reference} is being closed`}
            onChange={(e) => setReason(e.target.value as "expire" | "cancel")}>
            <option value="expire">it reached its expiry of {expiresOn}</option>
            <option value="cancel">it was cancelled before then</option>
          </select>
        </label>
        <button type="button" className="sw-btn sw-btn-primary" disabled={busy || !on}
          data-testid={`close-confirm-${reference}`}
          onClick={() => onClose(on, reason)}>
          {busy ? "Closing…" : "Close it"}
        </button>
        <button type="button" className="sw-btn" onClick={onCancel}>Leave it open</button>
      </div>
      <p className="sw-sub mt-2 max-w-[70ch]">
        {BigInt(marginMinor) > 0n
          ? <>The margin of <Figure minor={marginMinor} currency={currency} colour={false} /> comes back out of 1255
              and into the bank account. Nothing else is posted — the face of the facility never reached an
              account.</>
          : "Nothing is posted: no margin was held, and the face of a facility never reached an account."}
      </p>
    </div>
  );
}
