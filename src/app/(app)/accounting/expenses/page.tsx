"use client";

import * as React from "react";
import Link from "next/link";
import { api, ApiError, useEntityId, useLedgerQuery } from "@/components/ledger/use-ledger";
import { Figure, PageHead, Panel, ErrorNote, Loading, Empty } from "@/components/ledger/primitives";
import { useAsk } from "@/components/ledger/ask";
import { parseAmount } from "@/lib/ledger/format";

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

const EXPLAIN: Record<string, string> = {
  draft: "Being put together. Nobody else has seen it.",
  submitted: "With an approver — who may not be the claimant.",
  approved: "Approved and waiting to be posted.",
  rejected: "Sent back with a reason.",
  posted: "In the ledger, owed to the employee.",
  paid: "Reimbursed and closed.",
};

const CHIP: Record<string, string> = {
  draft: "", submitted: "sw-chip-warn", approved: "sw-chip-accent",
  rejected: "sw-chip-bad", posted: "sw-chip-ok", paid: "sw-chip-ok",
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
                    <td className="sw-code">{c.reference}</td>
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
                      <span className={`sw-chip ${CHIP[c.status] ?? ""}`}>{c.status}</span>
                      <span className="sr-only"> — {EXPLAIN[c.status]}</span>
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
            claim &mdash; an employee cannot be paid twice by clicking twice.
          </p>
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

interface DraftLine {
  spentOn: string; description: string; accountCode: string;
  netMinor: string; vatMinor: string; supplierTrn: string;
  vatRecoverable: boolean; receiptRef: string;
}

/** The accounts an expense claim realistically lands in. */
const ACCOUNTS = [
  ["6400", "Travel and entertainment"],
  ["6900", "Other operating expenses"],
  ["6150", "Utilities"],
  ["6300", "Government fees and licences"],
  ["6450", "Repairs and maintenance"],
  ["6200", "Marketing and advertising"],
];

function NewClaim({ busy, onCreate }: {
  busy: boolean;
  onCreate: (claim: {
    reference: string; employeeCode: string; employeeName: string; claimedOn: string;
    notes?: string; lines: DraftLine[];
  }) => void;
}) {
  const [head, setHead] = React.useState({ reference: "", employeeCode: "", employeeName: "", claimedOn: today(), notes: "" });
  const [lines, setLines] = React.useState<DraftLine[]>([]);
  const [line, setLine] = React.useState<{
    spentOn: string; description: string; accountCode: string;
    net: string; vat: string; supplierTrn: string; vatRecoverable: boolean; receiptRef: string;
  }>({ spentOn: today(), description: "", accountCode: "6400", net: "", vat: "", supplierTrn: "", vatRecoverable: false, receiptRef: "" });

  const net = parseAmount(line.net);
  const vat = parseAmount(line.vat) ?? 0n;

  // The same rules the server enforces, said before the request rather than
  // after it. The server remains the authority; this is only courtesy.
  const lineBlocker =
    !line.description.trim() ? "Say what was bought." :
    net === null || net === 0n ? "How much was it?" :
    vat === null || vat < 0n ? "VAT cannot be negative." :
    line.vatRecoverable && !/^\d{15}$/.test(line.supplierTrn.trim())
      ? "Reclaiming VAT needs the supplier's fifteen-digit TRN from the tax invoice." :
    line.vatRecoverable && vat <= 0n ? "There is no VAT on this line to reclaim." :
    null;

  const addLine = () => {
    if (lineBlocker || net === null) return;
    setLines((ls) => [...ls, {
      spentOn: line.spentOn,
      description: line.description.trim(),
      accountCode: line.accountCode,
      netMinor: net.toString(),
      vatMinor: (vat ?? 0n).toString(),
      supplierTrn: line.supplierTrn.trim(),
      vatRecoverable: line.vatRecoverable,
      receiptRef: line.receiptRef.trim(),
    }]);
    setLine((l) => ({ ...l, description: "", net: "", vat: "", supplierTrn: "", vatRecoverable: false, receiptRef: "" }));
  };

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
        <Field label="Employee code"><input className="sw-input" value={head.employeeCode} onChange={(e) => setHead({ ...head, employeeCode: e.target.value })} placeholder="E-001" /></Field>
        <Field label="Employee name"><input className="sw-input" value={head.employeeName} onChange={(e) => setHead({ ...head, employeeName: e.target.value })} placeholder="Layla Haddad" /></Field>
        <Field label="Claim date"><input type="date" className="sw-input" value={head.claimedOn} onChange={(e) => setHead({ ...head, claimedOn: e.target.value })} /></Field>
      </div>

      {lines.length > 0 && (
        <div className="sw-scroll mt-4">
          <table className="sw-table">
            <caption className="sr-only">Receipts on this claim</caption>
            <thead>
              <tr>
                <th style={{ width: "7rem" }}>Spent</th>
                <th>Description</th>
                <th style={{ width: "6rem" }}>Account</th>
                <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Net</th>
                <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>VAT</th>
                <th style={{ width: "9rem" }}>VAT treatment</th>
                <th style={{ width: "4rem" }}><span className="sr-only">Remove</span></th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={`${l.description}-${i}`}>
                  <td>{l.spentOn}</td>
                  <td className="max-w-0 truncate">{l.description}</td>
                  <td className="sw-code">{l.accountCode}</td>
                  <td className="sw-num"><Figure minor={l.netMinor} colour={false} /></td>
                  <td className="sw-num"><Figure minor={l.vatMinor} colour={false} /></td>
                  <td className="sw-sub">
                    {l.vatRecoverable ? `reclaimed · ${l.supplierTrn}` : BigInt(l.vatMinor) > 0n ? "added to the expense" : "none"}
                  </td>
                  <td>
                    <button type="button" className="sw-btn sw-btn-sm"
                      onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Spent on"><input type="date" className="sw-input" value={line.spentOn} onChange={(e) => setLine({ ...line, spentOn: e.target.value })} /></Field>
        <Field label="Description"><input className="sw-input" value={line.description} onChange={(e) => setLine({ ...line, description: e.target.value })} placeholder="Airport taxi" /></Field>
        <Field label="Account">
          <select className="sw-select" value={line.accountCode} onChange={(e) => setLine({ ...line, accountCode: e.target.value })}>
            {ACCOUNTS.map(([code, name]) => <option key={code} value={code}>{code} {name}</option>)}
          </select>
        </Field>
        <Field label="Receipt reference"><input className="sw-input" value={line.receiptRef} onChange={(e) => setLine({ ...line, receiptRef: e.target.value })} placeholder="R-1042" /></Field>
        <Field label="Net"><input className="sw-input sw-cell-num" inputMode="decimal" value={line.net} onChange={(e) => setLine({ ...line, net: e.target.value })} placeholder="1,000.00" /></Field>
        <Field label="VAT"><input className="sw-input sw-cell-num" inputMode="decimal" value={line.vat} onChange={(e) => setLine({ ...line, vat: e.target.value })} placeholder="50.00" /></Field>
        <Field label="Supplier TRN"><input className="sw-input" inputMode="numeric" value={line.supplierTrn} onChange={(e) => setLine({ ...line, supplierTrn: e.target.value })} placeholder="100123456700003" /></Field>
        <label className="flex items-end gap-2 pb-1.5">
          <input
            type="checkbox"
            checked={line.vatRecoverable}
            onChange={(e) => setLine({ ...line, vatRecoverable: e.target.checked })}
            data-testid="vat-recoverable"
          />
          <span className="sw-label" style={{ textTransform: "none" }}>Reclaim this VAT</span>
        </label>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="sw-btn"
          disabled={lineBlocker !== null}
          aria-disabled={lineBlocker !== null || undefined}
          data-testid="add-claim-line"
          onClick={addLine}
        >
          Add receipt
        </button>
        {lineBlocker && <span className="sw-sub" role="status" data-testid="line-blocker">{lineBlocker}</span>}
        {!lineBlocker && line.vatRecoverable === false && vat > 0n && (
          <span className="sw-sub">
            This VAT will be added to {line.accountCode} rather than reclaimed — that is the treatment when there is
            no valid tax invoice behind it.
          </span>
        )}
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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="sw-label">{label}</span>
      <span className="mt-1 block">{children}</span>
    </label>
  );
}
