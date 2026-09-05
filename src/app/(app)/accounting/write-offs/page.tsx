"use client";

import * as React from "react";
import { api, ApiError, useEntityId, useLedgerQuery } from "@/components/ledger/use-ledger";
import { Figure, PageHead, Panel, ErrorNote, Loading, Empty } from "@/components/ledger/primitives";
import { parseAmount, toInput } from "@/lib/ledger/format";

/**
 * Bad debts.
 *
 * The screen deliberately puts the two decisions side by side and keeps them
 * apart: writing the debt off is an accounting judgement the business makes on
 * its own, and adjusting the output tax is a claim against the FTA that only
 * becomes available once Article 64(1) is satisfied. A single button doing both
 * would make the second one look automatic, which is exactly what it is not.
 */

interface Candidate {
  documentId: string;
  reference: string;
  memo: string;
  partyKey: string;
  partyName: string;
  invoicedOn: string;
  daysOld: number;
  outstandingMinor: string;
  vatMinor: string;
  reliefEligibleOn: string;
  reliefEligible: boolean;
}

interface WrittenOff {
  id: string;
  documentId: string;
  documentRef: string;
  partyKey: string;
  partyName: string;
  amountMinor: string;
  vatMinor: string;
  writtenOffOn: string;
  invoicedOn: string;
  reason: string;
  notifiedOn: string | null;
  vatAdjusted: boolean;
  entryId: string | null;
  outstandingMinor: string;
  reliefEligibleOn: string;
  blockedBecause: string[];
}

interface View {
  asOf: string;
  allowanceMinor: string;
  candidates: Candidate[];
  writeOffs: WrittenOff[];
}

const today = () => new Date().toISOString().slice(0, 10);

export default function WriteOffsPage() {
  const entityId = useEntityId();
  const [asOf, setAsOf] = React.useState(today);
  const { data, error, loading, reload } = useLedgerQuery<View>(
    entityId ? `/api/ledger/write-offs?entityId=${entityId}&asOf=${asOf}` : null,
    [asOf],
  );

  const [chosen, setChosen] = React.useState<Candidate | null>(null);
  const [confirming, setConfirming] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [err, setErr] = React.useState<string | null>(null);

  const act = async (label: string, body: Record<string, unknown>) => {
    setBusy(label); setErr(null); setMsg(null);
    try {
      const r = await api<Record<string, unknown>>("/api/ledger/write-offs", {
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

  if (!entityId) return <Loading label="Choosing an entity…" />;

  const awaitingRelief = (data?.writeOffs ?? []).filter((w) => !w.vatAdjusted && BigInt(w.vatMinor) > 0n);

  return (
    <>
      <PageHead
        title="Bad debts"
        sub={
          "A debt that will never be paid has to be able to leave the sales ledger, or it ages forever and the " +
          "collections letters keep going out. Writing it off charges the loss and closes the open item. Taking the " +
          "VAT back is a second, separate act: Article 64(1) of Federal Decree-Law 8/2017 allows it only once six " +
          "months have passed since the supply and the customer has been told the amount written off."
        }
        actions={
          <label className="flex items-center gap-1.5">
            <span className="sw-label">As at</span>
            <input type="date" className="sw-input" style={{ width: "10rem" }} value={asOf}
              onChange={(e) => setAsOf(e.target.value)} aria-label="Date to show the debts up to" />
          </label>
        }
      />

      {err && <ErrorNote>{err}</ErrorNote>}
      {msg && <div className="sw-note mb-3" role="status" data-testid="write-off-result">{msg}</div>}
      {error && <ErrorNote>{error}</ErrorNote>}
      {loading && !data && <Loading />}

      {data && (
        <>
          <Panel className="mb-4 p-4">
            <dl className="grid gap-4 sm:grid-cols-3">
              <div>
                <dt className="sw-label">Allowance carried</dt>
                <dd className="sw-num mt-1 text-lg" data-testid="allowance-balance">
                  <Figure minor={data.allowanceMinor} colour={false} />
                </dd>
                <p className="sw-sub mt-0.5">
                  On account 1150. A debt written off against it takes no further expense, because the expense was
                  taken when the allowance was raised.
                </p>
              </div>
              <div>
                <dt className="sw-label">Written off</dt>
                <dd className="sw-num mt-1 text-lg" data-testid="written-off-total">
                  <Figure
                    minor={data.writeOffs.reduce((a, w) => a + BigInt(w.amountMinor), 0n).toString()}
                    colour={false}
                  />
                </dd>
                <p className="sw-sub mt-0.5">{data.writeOffs.length} debt{data.writeOffs.length === 1 ? "" : "s"} on the record.</p>
              </div>
              <div>
                <dt className="sw-label">Tax not yet reclaimed</dt>
                <dd className="sw-num mt-1 text-lg" data-testid="unclaimed-vat">
                  <Figure
                    minor={awaitingRelief.reduce((a, w) => a + BigInt(w.vatMinor), 0n).toString()}
                    colour={false}
                  />
                </dd>
                <p className="sw-sub mt-0.5">
                  Output tax already paid to the FTA on money that never arrived. It stays on the open item until the
                  relief is claimed.
                </p>
              </div>
            </dl>
          </Panel>

          {chosen && (
            <WriteOffForm
              candidate={chosen}
              allowanceMinor={data.allowanceMinor}
              busy={busy === "writeOff"}
              onCancel={() => setChosen(null)}
              onSubmit={async (body) => {
                const r = await act("writeOff", { action: "writeOff", documentId: chosen.documentId, ...body });
                if (r) {
                  setChosen(null);
                  setMsg(
                    `Wrote off ${chosen.reference} as entry ${String(r.reference)}. ` +
                      (BigInt(String(r.vatHeldMinor ?? "0")) > 0n
                        ? "The tax element stays on the open item until the Article 64 adjustment is made."
                        : "The open item is closed."),
                  );
                }
              }}
            />
          )}

          <h2 className="sw-label mb-2">Debts that could be written off</h2>
          {data.candidates.length === 0 ? (
            <Empty>Nothing is outstanding on the receivables account at {data.asOf}.</Empty>
          ) : (
            <Panel className="mb-6 overflow-hidden">
              <div className="sw-scroll">
                <table className="sw-table">
                  <caption className="sr-only">Open receivables, oldest first</caption>
                  <thead>
                    <tr>
                      <th style={{ width: "12rem" }}>Customer</th>
                      <th style={{ width: "12rem" }}>Document</th>
                      <th style={{ width: "7rem" }}>Raised</th>
                      <th className="sw-num" style={{ width: "5rem" }}>Days</th>
                      <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Outstanding</th>
                      <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Tax in it</th>
                      <th style={{ width: "11rem" }}>Article 64</th>
                      <th style={{ width: "7rem" }}><span className="sr-only">Action</span></th>
                    </tr>
                  </thead>
                  <tbody data-testid="write-off-candidates">
                    {data.candidates.map((c) => (
                      <tr key={c.documentId}>
                        <td>{c.partyName}</td>
                        <td className="sw-code">{c.reference}</td>
                        <td>{c.invoicedOn}</td>
                        <td className="sw-num">{c.daysOld}</td>
                        <td className="sw-num"><Figure minor={c.outstandingMinor} colour={false} /></td>
                        <td className="sw-num"><Figure minor={c.vatMinor} colour={false} /></td>
                        <td className="sw-sub">
                          {BigInt(c.vatMinor) === 0n
                            ? "No output tax on the supply"
                            : c.reliefEligible
                              ? "Six months have passed"
                              : `Not until ${c.reliefEligibleOn}`}
                        </td>
                        <td>
                          <button type="button" className="sw-btn sw-btn-sm"
                            data-testid={`write-off-${c.documentId}`}
                            onClick={() => { setChosen(c); setMsg(null); setErr(null); }}>
                            Write off
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          )}

          <h2 className="sw-label mb-2">Written off</h2>
          {data.writeOffs.length === 0 ? (
            <Empty>Nothing has been written off in this entity.</Empty>
          ) : (
            <Panel className="overflow-hidden">
              <div className="sw-scroll">
                <table className="sw-table">
                  <caption className="sr-only">Debts written off, and the state of the tax on each</caption>
                  <thead>
                    <tr>
                      <th style={{ width: "12rem" }}>Customer</th>
                      <th style={{ width: "11rem" }}>Document</th>
                      <th style={{ width: "7rem" }}>Written off</th>
                      <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Amount</th>
                      <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Tax element</th>
                      <th>Reason, and the tax</th>
                      <th style={{ width: "12rem" }}><span className="sr-only">Actions</span></th>
                    </tr>
                  </thead>
                  <tbody data-testid="write-off-rows">
                    {data.writeOffs.map((w) => (
                      <tr key={w.id}>
                        <td>{w.partyName}</td>
                        <td className="sw-code">{w.documentRef}</td>
                        <td>{w.writtenOffOn}</td>
                        <td className="sw-num"><Figure minor={w.amountMinor} colour={false} /></td>
                        <td className="sw-num"><Figure minor={w.vatMinor} colour={false} /></td>
                        <td className="sw-sub">
                          {w.reason}
                          {w.vatAdjusted ? (
                            <span className="sw-chip sw-chip-ok ml-2">tax reclaimed</span>
                          ) : w.blockedBecause.length > 0 ? (
                            <span className="block mt-1">{w.blockedBecause.join(" ")}</span>
                          ) : (
                            <span className="sw-chip sw-chip-warn ml-2">tax may be reclaimed</span>
                          )}
                        </td>
                        <td>
                          <div className="flex flex-wrap items-center gap-2">
                            {!w.vatAdjusted && w.blockedBecause.length === 0 && (
                              <button type="button" className="sw-btn sw-btn-sm"
                                disabled={busy === "adjustVat"}
                                data-testid={`adjust-vat-${w.id}`}
                                onClick={async () => {
                                  const r = await act("adjustVat", { action: "adjustVat", writeOffId: w.id, adjustedOn: asOf });
                                  if (r) setMsg(`Reclaimed the output tax on ${w.documentRef} as entry ${String(r.reference)}.`);
                                }}>
                                Reclaim the tax
                              </button>
                            )}
                            {confirming === w.id ? (
                              <>
                                <span className="sw-sub">Put the debt back?</span>
                                <button type="button" className="sw-btn sw-btn-sm sw-btn-primary"
                                  disabled={busy === "reverse"}
                                  data-testid={`confirm-reverse-${w.id}`}
                                  onClick={async () => {
                                    const r = await act("reverse", { action: "reverse", writeOffId: w.id, reversedOn: asOf });
                                    setConfirming(null);
                                    if (r) {
                                      setMsg(
                                        `Put ${w.documentRef} back on the ledger as ` +
                                          `${(r.references as string[]).join(", ")}. It is open again for the same item.`,
                                      );
                                    }
                                  }}>
                                  Yes, reverse it
                                </button>
                                <button type="button" className="sw-btn sw-btn-sm" onClick={() => setConfirming(null)}>
                                  Keep it
                                </button>
                              </>
                            ) : (
                              <button type="button" className="sw-btn sw-btn-sm"
                                data-testid={`reverse-${w.id}`}
                                onClick={() => { setConfirming(w.id); setErr(null); setMsg(null); }}>
                                Reverse
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          )}

          <p className="sw-sub mt-4 max-w-[75ch]">
            A reversal puts the debt back on the same open item rather than opening a new one beside it, which is what
            a customer who pays after being written off needs. Where the tax had been reclaimed it is reversed too, and
            first — the debt cannot be back on the books while the FTA has still given the tax back.
          </p>
        </>
      )}
    </>
  );
}

function WriteOffForm({ candidate, allowanceMinor, busy, onCancel, onSubmit }: {
  candidate: Candidate;
  allowanceMinor: string;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (body: Record<string, unknown>) => void;
}) {
  const [amount, setAmount] = React.useState(() => toInput(candidate.outstandingMinor));
  const [reason, setReason] = React.useState("");
  const [against, setAgainst] = React.useState<"expense" | "allowance">("expense");
  const [writtenOffOn, setWrittenOffOn] = React.useState(today);
  const [reclaim, setReclaim] = React.useState(false);
  const [notifiedOn, setNotifiedOn] = React.useState("");
  const [err, setErr] = React.useState<string | null>(null);

  const outstanding = BigInt(candidate.outstandingMinor);
  const availableVat = BigInt(candidate.vatMinor);
  const parsed = parseAmount(amount, "AED");
  // The tax element moves with the amount, in the same proportion the ledger
  // holds it in: half the debt written off carries half its tax.
  const vat = !reclaim || parsed === null || parsed <= 0n || outstanding <= 0n
    ? 0n
    : parsed >= outstanding
      ? availableVat
      : (2n * availableVat * parsed + outstanding) / (2n * outstanding);

  return (
    <Panel className="mb-4 p-4">
      <div className="sw-label">Write off {candidate.reference} — {candidate.partyName}</div>
      <p className="sw-sub mt-1 max-w-[75ch]">
        Raised {candidate.invoicedOn}, {candidate.daysOld} days ago, with{" "}
        <Figure minor={candidate.outstandingMinor} colour={false} /> outstanding.
      </p>

      <div className="mt-3 grid gap-3 sm:grid-cols-4">
        <label className="block">
          <span className="sw-label">How much is irrecoverable</span>
          <input className="sw-input sw-num mt-1" value={amount} onChange={(e) => setAmount(e.target.value)}
            aria-label="Amount to write off" placeholder="0.00" />
        </label>
        <label className="block">
          <span className="sw-label">Written off on</span>
          <input type="date" className="sw-input mt-1" value={writtenOffOn}
            onChange={(e) => setWrittenOffOn(e.target.value)} aria-label="Date the debt is written off" />
        </label>
        <label className="block">
          <span className="sw-label">Charged to</span>
          <select className="sw-select mt-1" value={against}
            onChange={(e) => setAgainst(e.target.value as "expense" | "allowance")}
            aria-label="Which account carries the loss">
            <option value="expense">6260 Bad debts written off</option>
            <option value="allowance">1150 Allowance for doubtful debts</option>
          </select>
          <span className="sw-sub">
            {against === "allowance"
              ? <>Allowance carried: <Figure minor={allowanceMinor} colour={false} />.</>
              : "The loss is taken now, in full."}
          </span>
        </label>
        <label className="block sm:col-span-4">
          <span className="sw-label">Why it will never be paid</span>
          <input className="sw-input mt-1" value={reason} onChange={(e) => setReason(e.target.value)}
            aria-label="Reason the debt is irrecoverable"
            placeholder="Customer liquidated, final distribution received" />
        </label>
      </div>

      {availableVat > 0n && (
        <>
          <label className="mt-3 flex items-center gap-2">
            <input type="checkbox" className="sw-check" checked={reclaim}
              onChange={(e) => setReclaim(e.target.checked)} data-testid="reclaim-vat" />
            <span>
              Intend to reclaim the output tax under Article 64. The tax element is held back from the expense and
              stays on the open item until the adjustment is made.
            </span>
          </label>
          {reclaim && (
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <div>
                <span className="sw-label">Tax held back</span>
                <p className="sw-num mt-1" data-testid="held-vat"><Figure minor={vat.toString()} colour={false} /></p>
                <span className="sw-sub">
                  {candidate.reliefEligible
                    ? "Six months have passed since the supply."
                    : `Cannot be reclaimed until ${candidate.reliefEligibleOn}.`}
                </span>
              </div>
              <label className="block">
                <span className="sw-label">Customer notified on</span>
                <input type="date" className="sw-input mt-1" value={notifiedOn}
                  onChange={(e) => setNotifiedOn(e.target.value)} aria-label="Date the customer was notified" />
                <span className="sw-sub">
                  Article 64(1)(d). It can be recorded later, but the tax cannot be reclaimed without it.
                </span>
              </label>
            </div>
          )}
        </>
      )}

      {err && <div className="sw-error mt-2" role="alert">{err}</div>}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="button" className="sw-btn sw-btn-primary" disabled={busy} data-testid="save-write-off"
          onClick={() => {
            if (parsed === null || parsed <= 0n) { setErr("Give the amount being written off."); return; }
            if (parsed > outstanding) { setErr("More than is outstanding cannot be written off."); return; }
            if (reason.trim().length < 4) { setErr("Say why the debt is irrecoverable. An auditor will ask."); return; }
            setErr(null);
            onSubmit({
              amountMinor: parsed.toString(),
              vatMinor: vat.toString(),
              writtenOffOn,
              reason: reason.trim(),
              against,
              notifiedOn: notifiedOn || undefined,
            });
          }}>
          {busy ? "Posting…" : "Write it off"}
        </button>
        <button type="button" className="sw-btn" onClick={onCancel} data-testid="cancel-write-off">Cancel</button>
      </div>
    </Panel>
  );
}
