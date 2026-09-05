"use client";

import * as React from "react";
import Link from "next/link";
import { api, ApiError, useEntityId, useLedgerQuery } from "@/components/ledger/use-ledger";
import { Figure, PageHead, Panel, ErrorNote, Loading, Empty } from "@/components/ledger/primitives";
import { useAsk } from "@/components/ledger/ask";
import { ClaimDetail, CLAIM_CHIP, CLAIM_EXPLAIN } from "@/components/ledger/claim-detail";
import { ClaimLineFields, ClaimLinesTable, type DraftLine } from "@/components/ledger/claim-line-form";
import { Field } from "@/components/ledger/ap-coding";

interface Totals {
  netMinor: string; vatMinor: string; recoverableVatMinor: string;
  blockedVatMinor: string; expenseMinor: string; totalMinor: string;
}
interface ClaimRow {
  id: string; reference: string; employeeCode: string; employeeName: string;
  claimedOn: string; currency: string; status: string; lineCount: number;
  approvedBy: string | null; rejectedReason: string | null;
  entryId: string | null; paidEntryId: string | null; totals: Totals;
}
interface ClaimListResponse {
  claims: ClaimRow[];
  summary: {
    awaitingApprovalMinor: string; awaitingApprovalCount: number;
    approvedUnpaidMinor: string; approvedUnpaidCount: number;
  };
}

/**
 * Mirrors the server's transition map. The server is still the authority — this
 * only decides which buttons are worth showing, and a stale tab that offers the
 * wrong one gets a full sentence back explaining why, rather than a 500.
 */
const ACTIONS: Record<
  string,
  {
    action: string; label: string; primary?: boolean; reason?: boolean;
    /** Asked before the action runs, saying what it will do rather than only that it will. */
    confirm?: { title: string; detail: string; confirmLabel: string };
  }[]
> = {
  draft: [{ action: "submit", label: "Submit", primary: true }],
  submitted: [
    { action: "approve", label: "Approve", primary: true },
    { action: "reject", label: "Reject", reason: true },
    { action: "reopen", label: "Send back" },
  ],
  approved: [
    { action: "post", label: "Post to ledger", primary: true },
    { action: "reject", label: "Reject", reason: true },
  ],
  rejected: [{ action: "reopen", label: "Back to draft" }],
  posted: [{
    action: "pay",
    label: "Reimburse",
    primary: true,
    confirm: {
      title: "Post the payment out of the bank for this claim?",
      detail:
        "An entry is posted now: the bank down by the full amount, and what the business owed the employee cleared. " +
        "Like any posted entry it is corrected by a reversal rather than an edit, so post it once the transfer has " +
        "actually been made.",
      confirmLabel: "Post the reimbursement",
    },
  }],
  paid: [],
};

const today = () => new Date().toISOString().slice(0, 10);

export default function ExpenseClaimsPage() {
  const entityId = useEntityId();
  const { data, error, loading, reload } = useLedgerQuery<ClaimListResponse>(
    entityId ? `/api/ledger/expenses?entityId=${entityId}` : null,
  );
  const [busy, setBusy] = React.useState<string | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [drafting, setDrafting] = React.useState(false);
  /** The claim whose detail panel is open, by id. One at a time. */
  const [selected, setSelected] = React.useState<string | null>(null);
  const ask = useAsk();

  const act = async (key: string, body: Record<string, unknown>) => {
    setBusy(key); setErr(null); setMsg(null);
    try {
      const r = await api<Record<string, unknown>>("/api/ledger/expenses", {
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

  const run = async (claim: ClaimRow, a: (typeof ACTIONS)[string][number]) => {
    let reason: string | undefined;
    if (a.reason) {
      const answer = await ask({
        title: `Why is ${claim.reference} being rejected?`,
        detail:
          `${claim.employeeName} sees this reason on the claim, and nothing is posted. The claim can be sent back to ` +
          "draft afterwards, fixed and submitted again — at which point the reason is cleared, so it is only ever the " +
          "instruction for what to change.",
        reason: {
          label: "Reason",
          placeholder: "The taxi receipt is for 12 March; the trip on the claim is 12 April",
          minLength: 12,
          hint: "Say what has to change. A claim rejected without that comes straight back unchanged.",
        },
        confirmLabel: "Reject the claim",
      });
      if (answer === null) return;
      reason = answer;
    }
    if (a.confirm) {
      const go = await ask({
        title: a.confirm.title,
        detail: `${claim.reference} — ${claim.employeeName}. ${a.confirm.detail}`,
        confirmLabel: a.confirm.confirmLabel,
      });
      if (go === null) return;
    }

    const r = await act(`${claim.id}:${a.action}`, { action: a.action, claimId: claim.id, reason });
    if (!r) return;
    if (a.action === "post") setMsg(`${claim.reference} posted as ${String(r.reference)}.`);
    else if (a.action === "pay") setMsg(`${claim.reference} reimbursed as ${String(r.reference)}.`);
  };

  if (!entityId) return <Loading label="Choosing an entity…" />;
  const claims = data?.claims ?? [];

  return (
    <>
      <PageHead
        title="Expense claims"
        sub="What staff spent out of their own pocket, and what the business owes them for it. A claim is approved by somebody other than the claimant before it reaches the ledger — that separation is the whole control."
        actions={
          <button type="button" className="sw-btn" onClick={() => setDrafting((d) => !d)} data-testid="new-claim">
            {drafting ? "Cancel" : "New claim"}
          </button>
        }
      />

      {err && <ErrorNote>{err}</ErrorNote>}
      {msg && <div className="sw-note mb-3" role="status" data-testid="claim-result">{msg}</div>}
      {error && <ErrorNote>{error}</ErrorNote>}

      {data && (
        <Panel className="mb-4 p-4">
          <div className="grid gap-4 sm:grid-cols-2" style={{ maxWidth: "44rem" }}>
            <Tile
              label="Waiting for approval"
              testId="awaiting-approval"
              minor={data.summary.awaitingApprovalMinor}
              count={data.summary.awaitingApprovalCount}
              note="Submitted, and nobody has looked at it yet."
            />
            <Tile
              label="Owed to staff"
              testId="owed-to-staff"
              minor={data.summary.approvedUnpaidMinor}
              count={data.summary.approvedUnpaidCount}
              note="Approved or posted, and still not reimbursed."
            />
          </div>
        </Panel>
      )}

      {drafting && (
        <NewClaim
          busy={busy === "create"}
          onCreate={async (claim) => {
            const r = await act("create", { action: "create", claim });
            if (r) { setDrafting(false); setMsg(`Claim ${claim.reference} started as a draft. Submit it when the receipts are on it.`); }
          }}
        />
      )}

      {loading && !data && <Loading />}
      {data && claims.length === 0 && <Empty>No expense claims yet.</Empty>}

      {claims.length > 0 && (
        <Panel className="overflow-hidden">
          <div className="sw-scroll">
            <table className="sw-table">
              <caption className="sr-only">Employee expense claims</caption>
              <thead>
                <tr>
                  <th style={{ width: "8rem" }}>Reference</th>
                  <th>Employee</th>
                  <th style={{ width: "7rem" }}>Claimed</th>
                  <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Expense</th>
                  <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>VAT reclaimed</th>
                  <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Owed</th>
                  <th style={{ width: "8rem" }}>Status</th>
                  <th style={{ width: "16rem" }}><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {claims.map((c) => (
                  <tr key={c.id} data-testid={`claim-${c.reference}`}>
                    <td className="sw-code">
                      {/* The reference opens the claim. A rejected claim has a
                          reason on it and receipts that have to be corrected,
                          and both live in the detail below — so the way in is
                          the thing every row already shows. */}
                      <button
                        type="button"
                        className="sw-link sw-link-btn"
                        aria-expanded={selected === c.id}
                        data-testid="open-claim"
                        onClick={() => setSelected(selected === c.id ? null : c.id)}
                      >
                        {c.reference}
                      </button>
                    </td>
                    <td className="max-w-0 truncate">
                      {c.employeeName}
                      <span className="sw-sub"> · {c.employeeCode}</span>
                      {c.rejectedReason && (
                        <span className="block text-[0.6875rem]" style={{ color: "var(--sw-neg)" }}>{c.rejectedReason}</span>
                      )}
                    </td>
                    <td>{c.claimedOn}</td>
                    <td className="sw-num">
                      <Figure minor={c.totals.expenseMinor} currency={c.currency} colour={false} />
                      {BigInt(c.totals.blockedVatMinor) > 0n && (
                        <span className="block text-[0.6875rem]" style={{ color: "var(--sw-fg-muted)" }}>
                          includes VAT that cannot be reclaimed
                        </span>
                      )}
                    </td>
                    <td className="sw-num"><Figure minor={c.totals.recoverableVatMinor} currency={c.currency} colour={false} /></td>
                    <td className="sw-num"><Figure minor={c.totals.totalMinor} currency={c.currency} colour={false} /></td>
                    <td>
                      <span className={`sw-chip ${CLAIM_CHIP[c.status] ?? ""}`}>{c.status}</span>
                      <span className="sr-only"> — {CLAIM_EXPLAIN[c.status]}</span>
                    </td>
                    <td>
                      <span className="flex flex-wrap gap-1.5 py-1">
                        {(ACTIONS[c.status] ?? []).map((a) => (
                          <button
                            key={a.action}
                            type="button"
                            className={`sw-btn sw-btn-sm ${a.primary ? "sw-btn-primary" : ""}`}
                            disabled={busy === `${c.id}:${a.action}`}
                            data-testid={`claim-${a.action}`}
                            onClick={() => run(c, a)}
                          >
                            {busy === `${c.id}:${a.action}` ? "…" : a.label}
                          </button>
                        ))}
                        {c.entryId && (
                          <Link href="/accounting/journals" className="sw-link sw-link-btn" style={{ fontSize: "0.75rem" }}>
                            Journal
                          </Link>
                        )}
                        {ACTIONS[c.status]?.length === 0 && !c.entryId && <span className="sw-sub">—</span>}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="sw-sub px-3 py-2" style={{ borderTop: "1px solid var(--sw-line)" }}>
            VAT is only reclaimed where the receipt is a tax invoice showing the supplier&rsquo;s TRN (UAE VAT
            Decree-Law Art 55). Everywhere else it is added to the expense, because VAT that cannot be reclaimed is
            part of what the thing cost. Posting and reimbursement are separate entries, each idempotent on the
            claim &mdash; an employee cannot be paid twice by clicking twice. A claim is opened by its reference:
            that is where the reason it came back is written, and where its receipts are corrected before it goes
            round again.
          </p>
        </Panel>
      )}

      {selected && (
        <Panel className="mt-4 overflow-hidden">
          <ClaimDetail claimId={selected} onChanged={reload} />
        </Panel>
      )}
    </>
  );
}

function Tile({ label, minor, count, note, testId }: {
  label: string; minor: string; count: number; note: string; testId: string;
}) {
  return (
    <div>
      <div className="sw-label">{label}</div>
      <div className="mt-1 font-semibold tabular-nums" style={{ fontSize: "1.5rem" }} data-testid={`${testId}-total`}>
        <Figure minor={minor} zero="zero" colour={false} />
      </div>
      <div className="sw-sub" data-testid={`${testId}-count`}>
        {count} claim{count === 1 ? "" : "s"} · {note}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- new claim */

function NewClaim({ busy, onCreate }: {
  busy: boolean;
  onCreate: (claim: {
    reference: string; employeeCode: string; employeeName: string; claimedOn: string;
    notes?: string; lines: DraftLine[];
  }) => void;
}) {
  const [head, setHead] = React.useState({ reference: "", employeeCode: "", employeeName: "", claimedOn: today(), notes: "" });
  const [lines, setLines] = React.useState<DraftLine[]>([]);

  const owed = lines.reduce((a, l) => a + BigInt(l.netMinor) + BigInt(l.vatMinor), 0n);
  const blocker =
    !head.reference.trim() ? "Give the claim a reference." :
    !head.employeeCode.trim() ? "Which employee?" :
    !head.employeeName.trim() ? "Name the employee being reimbursed." :
    lines.length === 0 ? "Add at least one receipt." :
    null;

  return (
    <Panel className="mb-4 p-4">
      <div className="sw-label">New expense claim</div>
      <p className="sw-sub mt-1 max-w-[70ch]">
        This only drafts the claim. It reaches the ledger after somebody other than the claimant approves it.
      </p>

      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Reference"><input className="sw-input" value={head.reference} onChange={(e) => setHead({ ...head, reference: e.target.value })} placeholder="EXP-2026-014" /></Field>
        <Field label="Employee code" hint="The claimant's own code — what the self-approval check compares against.">
          <input className="sw-input" value={head.employeeCode} onChange={(e) => setHead({ ...head, employeeCode: e.target.value })} placeholder="E-001" />
        </Field>
        <Field label="Employee name"><input className="sw-input" value={head.employeeName} onChange={(e) => setHead({ ...head, employeeName: e.target.value })} placeholder="Layla Haddad" /></Field>
        <Field label="Claim date"><input type="date" className="sw-input" value={head.claimedOn} onChange={(e) => setHead({ ...head, claimedOn: e.target.value })} /></Field>
        {/* The claim has carried a note to the approver all along and this form
            never asked for one, so every claim reached its approver with the
            field empty. It is the one place to say what a receipt cannot. */}
        <Field label="Note" hint="Anything the approver should read that a receipt does not say.">
          <input className="sw-input" value={head.notes} onChange={(e) => setHead({ ...head, notes: e.target.value })} placeholder="Client visit, Abu Dhabi" />
        </Field>
      </div>

      {lines.length > 0 && (
        <div className="mt-4">
          <ClaimLinesTable
            lines={lines}
            caption="The receipts on this claim"
            onRemove={(i) => setLines((ls) => ls.filter((_, j) => j !== i))}
          />
        </div>
      )}

      <div className="mt-4">
        <ClaimLineFields onAdd={(line) => setLines((ls) => [...ls, line])} />
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3" style={{ borderTop: "1px solid var(--sw-line)", paddingTop: "0.75rem" }}>
        <button
          type="button"
          className="sw-btn sw-btn-primary"
          disabled={blocker !== null || busy}
          aria-disabled={blocker !== null || busy || undefined}
          data-testid="save-claim"
          onClick={() => onCreate({
            reference: head.reference.trim(),
            employeeCode: head.employeeCode.trim(),
            employeeName: head.employeeName.trim(),
            claimedOn: head.claimedOn,
            notes: head.notes.trim() || undefined,
            lines,
          })}
        >
          {busy ? "Saving…" : "Start the claim"}
        </button>
        {blocker && <span className="sw-sub" role="status" data-testid="claim-blocker">{blocker}</span>}
        {!blocker && (
          <span className="sw-sub" data-testid="claim-owed">
            {lines.length} receipt{lines.length === 1 ? "" : "s"} · owed to the employee <Figure minor={owed} zero="zero" colour={false} />
          </span>
        )}
      </div>
    </Panel>
  );
}
