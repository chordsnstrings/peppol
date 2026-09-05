"use client";

import * as React from "react";
import Link from "next/link";
import { api, ApiError, useEntityId, useLedgerQuery } from "@/components/ledger/use-ledger";
import { Figure, PageHead, Panel, ErrorNote, Loading, Empty, StatusChip } from "@/components/ledger/primitives";
import { useAsk } from "@/components/ledger/ask";

/* ------------------------------------------------------------------- wire --- */

interface RunItem {
  id: string; billId: string | null; billNumber: string; supplierName: string;
  amountMinor: string; excluded: boolean; excludeReason: string | null;
}
interface RunEntry { id: string; reference: string; entryDate: string; settlesId: string | null }
interface RunDetail {
  id: string; reference: string; runDate: string; bankAccount: string; currency: string;
  status: "draft" | "approved" | "released" | "cancelled";
  approvedBy: string | null; approvedAt: string | null; releasedAt: string | null; entryId: string | null;
  items: RunItem[]; includedCount: number; excludedCount: number;
  totalMinor: string; excludedMinor: string; entries: RunEntry[];
  notDue?: { billId: string; billNumber: string; supplierName: string; amountMinor: string; dueDate: string }[];
}
interface RunRow {
  id: string; reference: string; runDate: string; status: RunDetail["status"];
  bankAccount: string; currency: string; approvedBy: string | null;
  includedCount: number; excludedCount: number; totalMinor: string; excludedMinor: string;
}
interface RunListResponse { runs: RunRow[]; awaitingReleaseMinor: string; awaitingApprovalMinor: string }
interface BankFileResult { reference: string; filename: string; rows: number; totalMinor: string; csv: string }

const today = () => new Date().toISOString().slice(0, 10);
const sum = <T,>(rows: T[], pick: (r: T) => string) => rows.reduce((a, r) => a + BigInt(pick(r) || "0"), 0n).toString();

/* ------------------------------------------------------------------- page --- */

export default function PaymentRunsPage() {
  const entityId = useEntityId();
  const [selected, setSelected] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState({ runDate: today(), dueBy: today(), bankAccount: "1010" });
  const [ibans, setIbans] = React.useState<Record<string, string>>({});
  const [file, setFile] = React.useState<BankFileResult | null>(null);
  const ask = useAsk();

  const list = useLedgerQuery<RunListResponse>(entityId ? `/api/ledger/payment-runs?entityId=${entityId}` : null);
  const detail = useLedgerQuery<RunDetail>(
    selected ? `/api/ledger/payment-runs?runId=${encodeURIComponent(selected)}` : null,
    [selected],
  );

  const act = async <T,>(key: string, body: Record<string, unknown>): Promise<T | null> => {
    setBusy(key); setErr(null); setMsg(null);
    try {
      const r = await api<T>("/api/ledger/payment-runs", { method: "POST", body: JSON.stringify({ entityId, ...body }) });
      list.reload();
      if (selected) detail.reload();
      return r;
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "That did not work.");
      return null;
    } finally {
      setBusy(null);
    }
  };

  const open = detail.data;
  const paying = open?.items.filter((i) => !i.excluded) ?? [];
  const left = open?.items.filter((i) => i.excluded) ?? [];
  const beneficiaries = [...new Set(paying.map((i) => i.supplierName))];

  // Built server-side and shown before it is saved: a bank rejects the whole
  // file for one bad row, so the operator gets to read it first.
  const download = () => {
    if (!file) return;
    const url = URL.createObjectURL(new Blob([file.csv], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = file.filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (!entityId) return <Loading label="Choosing an entity…" />;

  return (
    <>
      <PageHead
        title="Payment runs"
        sub="What is due, paid as one batch. The run is built from the payables ageing — worst first — and everything it leaves out is written down with the reason, because a payment dropped without one is what a supplier chases and nobody can explain. Whoever prepares a run cannot approve it."
      />

      {err && <ErrorNote>{err}</ErrorNote>}
      {msg && <div className="sw-note mb-3" role="status" data-testid="payment-run-result">{msg}</div>}
      {list.error && <ErrorNote>{list.error}</ErrorNote>}
      {list.loading && !list.data && <Loading />}

      <Panel className="mb-4 p-4">
        <div className="sw-label">Propose a run</div>
        <p className="sw-sub mt-1 max-w-[70ch]">
          Every bill outstanding and due by the date goes in; a supplier on hold, a bill nobody has approved
          and an unapplied credit note come back as exclusions rather than silence.
        </p>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <Field label="Run date">
            <input type="date" className="sw-input" value={draft.runDate}
              onChange={(e) => setDraft((d) => ({ ...d, runDate: e.target.value }))} data-testid="run-date" />
          </Field>
          <Field label="Pay everything due by">
            <input type="date" className="sw-input" value={draft.dueBy}
              onChange={(e) => setDraft((d) => ({ ...d, dueBy: e.target.value }))} data-testid="run-due-by" />
          </Field>
          <Field label="From account">
            <input className="sw-input" value={draft.bankAccount} inputMode="numeric"
              onChange={(e) => setDraft((d) => ({ ...d, bankAccount: e.target.value }))} data-testid="run-bank-account" />
          </Field>
          <button
            type="button" className="sw-btn sw-btn-primary" data-testid="propose-run"
            disabled={busy !== null} aria-disabled={busy !== null || undefined}
            onClick={async () => {
              const r = await act<RunDetail>("propose", { action: "propose", ...draft });
              if (!r) return;
              setSelected(r.id);
              setFile(null);
              setMsg(
                `${r.reference} prepared: ${r.includedCount} payment${r.includedCount === 1 ? "" : "s"} to make and ` +
                `${r.excludedCount} left out with a reason. Nothing has been posted — somebody else has to approve it.`,
              );
            }}
          >
            {busy === "propose" ? "Proposing…" : "Propose"}
          </button>
        </div>
      </Panel>

      {list.data && (list.data.runs.length === 0 ? (
        <Empty>No payment runs yet. Propose one and see what is due.</Empty>
      ) : (
        <Panel className="mb-4 overflow-hidden">
          <div className="sw-scroll">
            <table className="sw-table">
              <caption className="sr-only">Every payment run, what it pays and what it leaves out</caption>
              <thead>
                <tr>
                  <th style={{ width: "11rem" }}>Run</th>
                  <th style={{ width: "7rem" }}>Date</th>
                  <th style={{ width: "8rem" }}>Status</th>
                  <th style={{ width: "9rem" }}>Approved by</th>
                  <th className="sw-num" style={{ width: "5rem" }}>Payments</th>
                  <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>To pay</th>
                  <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Left out</th>
                </tr>
              </thead>
              <tbody>
                {list.data.runs.map((r) => (
                  <tr key={r.id}>
                    <td className="sw-code">
                      <button
                        type="button" className="sw-link sw-link-btn" aria-expanded={selected === r.id}
                        onClick={() => { setSelected(selected === r.id ? null : r.id); setFile(null); }}
                      >
                        {r.reference}
                      </button>
                    </td>
                    <td>{r.runDate}</td>
                    <td><StatusChip status={r.status} /></td>
                    <td className="max-w-0 truncate">{r.approvedBy ?? <span className="sw-zero">–</span>}</td>
                    <td className="sw-num">{r.includedCount}</td>
                    <td className="sw-num"><Figure minor={r.totalMinor} currency={r.currency} zero="zero" colour={false} /></td>
                    <td className="sw-num"><Figure minor={r.excludedMinor} currency={r.currency} zero="zero" colour={false} /></td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row" colSpan={5} style={{ textAlign: "end" }}>
                    Approved and not yet released
                  </th>
                  <td className="sw-num" data-testid="awaiting-release">
                    <Figure minor={list.data.awaitingReleaseMinor} zero="zero" colour={false} />
                  </td>
                  <td className="sw-num">
                    <Figure minor={sum(list.data.runs, (r) => r.excludedMinor)} zero="zero" colour={false} />
                  </td>
                </tr>
                <tr>
                  <th scope="row" colSpan={5} style={{ textAlign: "end" }}>
                    Prepared and waiting for somebody to approve it
                  </th>
                  <td className="sw-num" data-testid="awaiting-approval">
                    <Figure minor={list.data.awaitingApprovalMinor} zero="zero" colour={false} />
                  </td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        </Panel>
      ))}

      {selected && detail.error && <ErrorNote>{detail.error}</ErrorNote>}

      {open && (
        <Panel className="mb-4 overflow-hidden">
          <div
            className="border-b px-3 py-2 flex flex-wrap items-center justify-between gap-2"
            style={{ borderColor: "var(--sw-line)", background: "var(--sw-surface-2)" }}
          >
            <span className="sw-label">
              {open.reference} — {open.runDate} — from {open.bankAccount}
              {open.approvedBy ? ` — approved by ${open.approvedBy}` : ""}
            </span>
            <div className="flex flex-wrap items-center gap-2">
              <StatusChip status={open.status} />
              {open.status === "draft" && (
                <button
                  type="button" className="sw-btn sw-btn-sm sw-btn-primary" data-testid="approve-run"
                  disabled={busy !== null} aria-disabled={busy !== null || undefined}
                  onClick={async () => {
                    // The run has nowhere to record who prepared it, so the
                    // approver is asked. Naming yourself here is refused.
                    const submittedBy = await ask({
                      title: `Who prepared ${open.reference}?`,
                      detail:
                        "Preparing a payment and approving it have to be two different people — that is the one " +
                        "control a payment run exists for, and the ledger refuses the approval if this name is " +
                        "yours. Approving posts nothing: the run then waits to be released, and only that moves money.",
                      reason: {
                        label: "Name",
                        placeholder: "Fatima Al Mansoori",
                        hint: "The person who put this run together, not you. It is checked against your own name.",
                      },
                      confirmLabel: "Approve the run",
                    });
                    if (submittedBy === null) return;
                    const r = await act<RunDetail>("approve", { action: "approve", runId: open.id, submittedBy });
                    if (r) setMsg(`${r.reference} approved by ${r.approvedBy}. Release it when the bank file has gone.`);
                  }}
                >
                  Approve
                </button>
              )}
              {open.status === "approved" && (
                <button
                  type="button" className="sw-btn sw-btn-sm sw-btn-primary" data-testid="release-run"
                  disabled={busy !== null} aria-disabled={busy !== null || undefined}
                  onClick={async () => {
                    const r = await act<RunDetail & { entryIds: string[]; alreadyReleased: boolean }>(
                      "release", { action: "release", runId: open.id },
                    );
                    if (!r) return;
                    setMsg(
                      r.alreadyReleased
                        ? `${r.reference} had already been released; nothing was posted again.`
                        : `${r.reference} released — ${r.entryIds.length} entries posted, one settling each bill.`,
                    );
                  }}
                >
                  Release
                </button>
              )}
              {(open.status === "draft" || open.status === "approved") && (
                <button
                  type="button" className="sw-btn sw-btn-sm" data-testid="cancel-run"
                  disabled={busy !== null} aria-disabled={busy !== null || undefined}
                  onClick={async () => {
                    const reason = await ask({
                      title: `Why is ${open.reference} being cancelled?`,
                      detail:
                        "Every bill still in the run is taken out of it and carries this reason, and the run stops " +
                        "there — it cannot be approved or released afterwards, and a fresh run has to be proposed to " +
                        "pay these suppliers. Nothing is posted: none of this money has left the bank yet.",
                      reason: {
                        label: "Reason",
                        placeholder: "The bank balance will not cover it until the Etisalat receipt clears",
                        minLength: 12,
                        hint: "Every supplier on this run inherits this sentence. It is what they are told when they ask why they were not paid.",
                      },
                      confirmLabel: "Cancel the run",
                      destructive: true,
                    });
                    if (reason === null) return;
                    const r = await act<RunDetail>("cancel", { action: "cancel", runId: open.id, reason });
                    if (r) setMsg(`${r.reference} cancelled. Every payment on it carries the reason.`);
                  }}
                >
                  Cancel
                </button>
              )}
            </div>
          </div>

          <div className="sw-scroll">
            <table className="sw-table">
              <caption className="sr-only">
                What {open.reference} pays, and what it leaves out with the reason
              </caption>
              <thead>
                <tr>
                  <th style={{ width: "10rem" }}>Bill</th>
                  <th style={{ width: "14rem" }}>Supplier</th>
                  <th>In the run</th>
                  <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Amount</th>
                  <th style={{ width: "7rem" }}><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {open.items.map((i) => (
                  <tr key={i.id}>
                    <td className="sw-code">
                      {i.billId
                        ? <Link href={`/invoices/${encodeURIComponent(i.billId)}`} className="sw-link">{i.billNumber}</Link>
                        : i.billNumber}
                    </td>
                    <td className="max-w-0 truncate">{i.supplierName}</td>
                    <td>
                      {i.excluded
                        ? <span style={{ color: "var(--sw-neg)" }}>{i.excludeReason}</span>
                        : <span className="sw-chip sw-chip-ok">paying</span>}
                    </td>
                    <td className="sw-num">
                      <Figure minor={i.amountMinor} currency={open.currency} colour={false} />
                    </td>
                    <td>
                      {open.status === "draft" && (
                        <button
                          type="button" className="sw-btn sw-btn-sm"
                          disabled={busy !== null} aria-disabled={busy !== null || undefined}
                          onClick={async () => {
                            const reason = i.excluded
                              ? await ask({
                                  title: `Why is ${i.billNumber} going back into ${open.reference}?`,
                                  detail:
                                    `${i.supplierName} is paid again by this run and the total the bank is asked ` +
                                    "for goes up by that much. The note replaces the reason it was left out with, so " +
                                    "say what changed rather than only that it did.",
                                  reason: {
                                    label: "Reason",
                                    placeholder: "The hold on the supplier was lifted this morning",
                                    hint: "This replaces the exclusion note on the bill; it is the only record of why it came back.",
                                  },
                                  confirmLabel: "Put it back in",
                                })
                              : await ask({
                                  title: `Why is ${i.billNumber} being left out of ${open.reference}?`,
                                  detail:
                                    `${i.supplierName} is not paid by this run and the total the bank is asked for ` +
                                    "drops by that much. The bill stays owing and comes back as a candidate for the " +
                                    "next run — leaving it out delays it, it does not settle or write it off.",
                                  reason: {
                                    label: "Reason",
                                    placeholder: "Query on the delivery — half of it was short",
                                    minLength: 8,
                                    hint: "This is the answer given three weeks later when the supplier asks why they were not paid.",
                                  },
                                  confirmLabel: "Leave it out",
                                });
                            if (reason === null) return;
                            await act<RunDetail>(i.excluded ? "include" : "exclude", {
                              action: i.excluded ? "include" : "exclude",
                              runId: open.id, itemId: i.id, reason,
                            });
                          }}
                        >
                          {i.excluded ? "Put back" : "Leave out"}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row" colSpan={3} style={{ textAlign: "end" }}>
                    What the bank will be asked for
                  </th>
                  <td className="sw-num" data-testid="run-total">
                    <Figure minor={open.totalMinor} currency={open.currency} zero="zero" colour={false} />
                  </td>
                  <td />
                </tr>
                <tr>
                  <th scope="row" colSpan={3} style={{ textAlign: "end" }}>
                    Left out, with a reason each
                  </th>
                  <td className="sw-num" data-testid="run-excluded">
                    <Figure minor={open.excludedMinor} currency={open.currency} zero="zero" colour={false} />
                  </td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>

          {left.length === 0 && paying.length === 0 && (
            <div className="p-3"><Empty>Nothing was outstanding and due by that date.</Empty></div>
          )}

          {open.entries.length > 0 && (
            <div className="sw-scroll" style={{ borderTop: "1px solid var(--sw-line)" }}>
              <table className="sw-table">
                <caption className="sr-only">The journal entries {open.reference} posted, one per bill settled</caption>
                <thead>
                  <tr>
                    <th style={{ width: "10rem" }}>Entry</th>
                    <th style={{ width: "8rem" }}>Date</th>
                    <th>Settles</th>
                  </tr>
                </thead>
                <tbody>
                  {open.entries.map((e) => (
                    <tr key={e.id}>
                      <td className="sw-code">
                        <Link href={`/accounting/journals/${encodeURIComponent(e.id)}`} className="sw-link">
                          {e.reference}
                        </Link>
                      </td>
                      <td>{e.entryDate}</td>
                      <td className="sw-code">{e.settlesId ?? <span className="sw-zero">–</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      )}

      {open && (open.status === "approved" || open.status === "released") && paying.length > 0 && (
        <Panel className="mb-4 p-4">
          <div className="sw-label">Bank file for {open.reference}</div>
          <p className="sw-sub mt-1 max-w-[70ch]">
            Supplier bank details are not held in the ledger, so the account each beneficiary is paid into is
            entered here. A bank rejects the whole file for one bad row, so it refuses to build until every
            beneficiary has an IBAN that passes its own check digits — and it names all of them at once.
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {beneficiaries.map((name) => (
              <Field key={name} label={name}>
                <input
                  className="sw-input" value={ibans[name] ?? ""} placeholder="AE07 0331 2345 6789 0123 456"
                  onChange={(e) => setIbans((v) => ({ ...v, [name]: e.target.value }))}
                  data-testid={`iban-${name}`}
                />
              </Field>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button" className="sw-btn" data-testid="build-bank-file"
              disabled={busy !== null} aria-disabled={busy !== null || undefined}
              onClick={async () => {
                setFile(null);
                const r = await act<BankFileResult>("bank-file", {
                  action: "bank-file", runId: open.id,
                  beneficiaries: beneficiaries.map((name) => ({ name, iban: ibans[name] ?? "" })),
                });
                if (!r) return;
                setFile(r);
                setMsg(`${r.filename} — ${r.rows} payment${r.rows === 1 ? "" : "s"}. Read it before it goes to the bank.`);
              }}
            >
              {busy === "bank-file" ? "Building…" : "Build file"}
            </button>
            {file && (
              <button type="button" className="sw-btn sw-btn-primary" onClick={download} data-testid="download-bank-file">
                Download {file.filename}
              </button>
            )}
          </div>
          {file && (
            <pre
              className="sw-scroll mt-3 p-2 text-[0.6875rem]" data-testid="bank-file-preview"
              style={{ border: "1px solid var(--sw-line)", whiteSpace: "pre", overflowX: "auto" }}
            >
              {file.csv}
            </pre>
          )}
        </Panel>
      )}
    </>
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
