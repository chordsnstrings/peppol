"use client";

import * as React from "react";
import Link from "next/link";
import { api, ApiError, useLedgerQuery } from "./use-ledger";
import { Figure, ErrorNote, Loading } from "./primitives";
import { Field } from "./ap-coding";
import { useAsk } from "./ask";
import { ClaimLineFields, ClaimLinesTable, type ClaimLineRow, type DraftLine } from "./claim-line-form";

/**
 * One expense claim, in full — and the only place a claim can be corrected.
 *
 * `claimDetail` has always returned the claim and its lines, and nothing in the
 * browser opened it. The gap was not cosmetic. The rejection dialog told the
 * claimant, word for word, that "the claim can be sent back to draft
 * afterwards, fixed and submitted again"; the claim could indeed be sent back
 * to draft, and once there the screen offered a Submit button and nothing else.
 * A receipt could not be taken off, a receipt could not be added, and the
 * header could not be touched — so the only way to act on a rejection was to
 * resubmit the same claim unchanged, which is precisely what the reason field
 * exists to prevent.
 *
 * Three things this view has to get right, all of them consequences of how the
 * subledger behaves rather than of how it looks:
 *
 *   The reason belongs at the top. Somebody opening a rejected claim is looking
 *   for one sentence, and it is not the totals.
 *
 *   The reason does not survive. `reopenClaim` and `submitClaim` both clear
 *   `rejectedReason`, so the moment the claim moves the instruction is gone
 *   from the record. That is a reasonable rule — a reason on a claim nobody has
 *   rejected would be read as a live objection — but it means the person has to
 *   be told before they move it, not after.
 *
 *   The claim's own status is not the whole story. Since the approval queue
 *   started seeding itself from the open registers, a claim carries its raiser
 *   and can also hold a rejected approval round, which stands until it is
 *   withdrawn on the approvals screen and which a fresh submission does not
 *   clear. A claimant who fixes the receipt and resubmits, and is still stuck,
 *   is stuck on that — so the round is read from the server and said out loud
 *   rather than left to be discovered.
 */

interface ClaimTotalsWire {
  netMinor: string;
  vatMinor: string;
  recoverableVatMinor: string;
  blockedVatMinor: string;
  expenseMinor: string;
  totalMinor: string;
}

interface DetailClaim {
  id: string;
  entityId: string;
  reference: string;
  employeeCode: string;
  employeeName: string;
  claimedOn: string;
  currency: string;
  status: string;
  lineCount: number;
  approvedBy: string | null;
  rejectedReason: string | null;
  entryId: string | null;
  paidEntryId: string | null;
  totals: ClaimTotalsWire;
  submittedAt: string | null;
  approvedAt: string | null;
  notes: string | null;
  entryReference: string | null;
  paidEntryReference: string | null;
  /** What the server will let this claim do next — its own transition map, not a guess. */
  nextStatuses: string[];
}

interface DetailLine extends ClaimLineRow {
  id: string;
  /** Net plus the VAT that cannot be reclaimed: what the line costs the P&L. */
  expenseMinor: string;
}

interface ClaimDetailResponse {
  claim: DetailClaim;
  lines: DetailLine[];
}

interface ApprovalStateWire {
  rejected: boolean;
  approved: boolean;
  approvalsOutstanding: number;
  rejection: { by: string; at: string; reason: string | null } | null;
  blockers: string[];
  caveats: string[];
}

/** How each status is drawn. Shared with the list, so one claim is one colour. */
export const CLAIM_CHIP: Record<string, string> = {
  draft: "", submitted: "sw-chip-warn", approved: "sw-chip-accent",
  rejected: "sw-chip-bad", posted: "sw-chip-ok", paid: "sw-chip-ok",
};

/** What each status means, in one line. */
export const CLAIM_EXPLAIN: Record<string, string> = {
  draft: "Being put together. Nobody else has seen it.",
  submitted: "With an approver — who may not be the claimant.",
  approved: "Approved and waiting to be posted.",
  rejected: "Sent back with a reason.",
  posted: "In the ledger, owed to the employee.",
  paid: "Reimbursed and closed.",
};

export function ClaimDetail({ claimId, onChanged }: {
  claimId: string;
  /** Reload the list behind this panel — its totals and its status column move too. */
  onChanged: () => void;
}) {
  const detail = useLedgerQuery<ClaimDetailResponse>(
    `/api/ledger/expenses?claimId=${encodeURIComponent(claimId)}`,
    [claimId],
  );
  const claim = detail.data?.claim ?? null;
  const lines = detail.data?.lines ?? [];

  /* The approval round on this claim, as the queue holds it. Read from the
   * server rather than assumed, because the honest sentence and the misleading
   * one differ only in whether a round exists: telling every claimant to go and
   * withdraw something would send most of them to an empty screen. */
  const approvals = useLedgerQuery<{ state: ApprovalStateWire }>(
    claim ? `/api/ledger/approvals?entityId=${encodeURIComponent(claim.entityId)}&subjectType=EXPENSE_CLAIM&subjectId=${encodeURIComponent(claim.id)}` : null,
    [claim?.entityId ?? "", claimId],
  );

  const [busy, setBusy] = React.useState<string | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [editing, setEditing] = React.useState(false);
  const ask = useAsk();

  const act = async (key: string, body: Record<string, unknown>) => {
    setBusy(key); setErr(null); setMsg(null);
    try {
      /* No entityId: every action here addresses an existing claim by id, and
       * the route reads the entity off the claim so the permission is checked
       * against the books the change lands in rather than the one a query
       * string claimed. */
      const r = await api<Record<string, unknown>>("/api/ledger/expenses", {
        method: "POST",
        body: JSON.stringify({ claimId, ...body }),
      });
      detail.reload();
      approvals.reload();
      onChanged();
      return r;
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "That did not work.");
      return null;
    } finally {
      setBusy(null);
    }
  };

  if (detail.loading && !detail.data) return <Loading label="Opening the claim…" />;
  if (detail.error) return <ErrorNote>{detail.error}</ErrorNote>;
  if (!claim) return null;

  const editable = claim.status === "draft";
  const canSubmit = claim.nextStatuses.includes("submitted");
  const canReopen = claim.nextStatuses.includes("draft");
  const owed = BigInt(claim.totals.totalMinor);

  const submit = async () => {
    const r = await act("submit", { action: "submit" });
    if (r) setMsg(`${claim.reference} is with an approver. It cannot be approved by ${claim.employeeName}.`);
  };

  const reopen = async () => {
    /* Asked, not assumed, because sending the claim back is what destroys the
     * reason — `reopenClaim` clears the field. Somebody who has not read it yet
     * would otherwise lose it by pressing the button that looks like the way
     * forward. The reason is quoted in the question so it is on screen at the
     * moment of the decision. */
    if (claim.rejectedReason) {
      const go = await ask({
        title: `Take ${claim.reference} back to draft?`,
        detail:
          `The reason it was sent back — "${claim.rejectedReason}" — is cleared when it goes back to draft, ` +
          "because a reason left on a claim nobody has rejected reads as a live objection. The claim keeps one " +
          "reason at a time, so read it, or copy it, before this goes ahead. Nothing is posted either way.",
        confirmLabel: "Back to draft",
      });
      if (go === null) return;
    }
    const r = await act("reopen", { action: "reopen" });
    if (r) setMsg(`${claim.reference} is a draft again. Correct the receipts below and submit it.`);
  };

  const addLine = async (line: DraftLine) => {
    const r = await act("addLine", { action: "addLine", line });
    if (r) setMsg(`Added "${line.description}" to ${claim.reference}.`);
  };

  const removeLine = async (index: number) => {
    const line = lines[index];
    if (!line) return;
    const r = await act(`removeLine:${line.id}`, { action: "removeLine", lineId: line.id });
    if (r) setMsg(`Took "${line.description}" off ${claim.reference}.`);
  };

  /* Which row is mid-removal, so only that row's button says so. -1 from
   * findIndex means none of them, which is not an index. */
  const removingAt = lines.findIndex((l) => busy === `removeLine:${l.id}`);

  return (
    <>
      <div
        className="border-b px-3 py-2 flex flex-wrap items-center justify-between gap-2"
        style={{ borderColor: "var(--sw-line)", background: "var(--sw-surface-2)" }}
      >
        <span className="sw-label">
          {claim.reference} — {claim.employeeName} ({claim.employeeCode}) — claimed {claim.claimedOn}
        </span>
        <div className="flex flex-wrap items-center gap-2">
          <span className={`sw-chip ${CLAIM_CHIP[claim.status] ?? ""}`} data-testid="claim-detail-status">
            {claim.status}
          </span>
          {canSubmit && (
            <button
              type="button"
              className="sw-btn sw-btn-sm sw-btn-primary"
              disabled={busy === "submit" || lines.length === 0}
              aria-disabled={busy === "submit" || lines.length === 0 || undefined}
              data-testid="claim-detail-submit"
              onClick={submit}
            >
              {busy === "submit" ? "…" : "Submit"}
            </button>
          )}
          {canReopen && (
            <button
              type="button"
              className="sw-btn sw-btn-sm"
              disabled={busy === "reopen"}
              data-testid="claim-detail-reopen"
              onClick={reopen}
            >
              {busy === "reopen" ? "…" : "Back to draft"}
            </button>
          )}
        </div>
      </div>

      <div className="p-3">
        {claim.rejectedReason && (
          <div className="sw-error mb-3 max-w-[76ch]" role="status" data-testid="claim-rejection">
            <strong>Sent back:</strong> {claim.rejectedReason}
            <span className="block sw-sub" style={{ color: "inherit" }}>
              This is the claim&rsquo;s only reason, and it is cleared the moment the claim goes back to draft.
              Read it before you move the claim.
            </span>
          </div>
        )}

        {err && <ErrorNote>{err}</ErrorNote>}
        {msg && <div className="sw-note mb-3" role="status" data-testid="claim-detail-result">{msg}</div>}

        <ApprovalRound
          state={approvals.data?.state ?? null}
          error={approvals.error}
          reference={claim.reference}
        />

        <p className="sw-sub max-w-[76ch]" data-testid="claim-detail-standing">
          {CLAIM_EXPLAIN[claim.status] ?? claim.status}{" "}
          {claim.status === "draft" || claim.status === "rejected" ? (
            <>
              It is approved by somebody other than {claim.employeeName} ({claim.employeeCode}) — the claim
              carries the claimant&rsquo;s code, and an approval signed with the same code is refused rather
              than recorded.
            </>
          ) : claim.status === "submitted" ? (
            <>
              Waiting since {claim.submittedAt?.slice(0, 10) ?? "it was sent"}. {claim.employeeName} (
              {claim.employeeCode}) cannot be the one who approves it.
            </>
          ) : claim.status === "approved" ? (
            <>
              Approved by {claim.approvedBy ?? "somebody"}
              {claim.approvedAt ? ` on ${claim.approvedAt.slice(0, 10)}` : ""}. Posting it charges the expense
              and the recoverable VAT, and credits what the business owes the employee to 2200.
            </>
          ) : claim.status === "posted" ? (
            <>
              In the ledger as {claim.entryReference ?? "an entry"}, sitting on 2200 until the employee is
              reimbursed. A posted claim is corrected by reversing that entry, never by editing the claim.
            </>
          ) : (
            <>
              Posted as {claim.entryReference ?? "an entry"} and reimbursed as{" "}
              {claim.paidEntryReference ?? "a payment"}. Nothing further happens to it.
            </>
          )}{" "}
          Approving, rejecting, posting and reimbursing are decisions somebody else takes, and they are on this
          claim&rsquo;s row in the list above; what happens here is the writing and the correcting.
        </p>

        {editable && (
          <div className="mt-3">
            <button
              type="button"
              className="sw-btn sw-btn-sm"
              aria-expanded={editing}
              data-testid="edit-claim-header"
              onClick={() => setEditing((e) => !e)}
            >
              {editing ? "Stop editing the details" : "Edit the details"}
            </button>
            {editing && (
              <ClaimHeaderForm
                claim={claim}
                busy={busy === "update"}
                onSave={async (patch) => {
                  const r = await act("update", { action: "update", patch });
                  if (r) { setEditing(false); setMsg(`${claim.reference} updated.`); }
                }}
              />
            )}
          </div>
        )}

        <div className="mt-4">
          <div className="sw-label">Receipts</div>
          {lines.length === 0 ? (
            <p className="sw-sub mt-1">
              Nothing on this claim yet. A claim with no receipts cannot be submitted — there would be nothing
              to approve.
            </p>
          ) : (
            <div className="mt-2">
              <ClaimLinesTable
                lines={lines}
                currency={claim.currency}
                caption={`The receipts on ${claim.reference}`}
                onRemove={editable ? removeLine : undefined}
                removingIndex={removingAt === -1 ? null : removingAt}
              />
            </div>
          )}
        </div>

        {editable ? (
          <div className="mt-4" style={{ borderTop: "1px solid var(--sw-line)", paddingTop: "0.75rem" }}>
            <div className="sw-label">Add a receipt</div>
            <p className="sw-sub mt-1 mb-3 max-w-[76ch]">
              A line is corrected by taking it off and putting it back on: the subledger has no verb that edits a
              saved line in place, and inventing one here would only look like it did.
            </p>
            <ClaimLineFields busy={busy === "addLine"} onAdd={addLine} />
          </div>
        ) : (
          <p className="sw-sub mt-3 max-w-[76ch]">
            Only a draft claim can be changed — an approver has to see the same claim the claimant submitted.
            {canReopen && " Take it back to draft to correct it."}
          </p>
        )}

        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <div className="sw-scroll">
            <table className="sw-table" style={{ maxWidth: "30rem" }}>
              <caption className="sr-only">What {claim.reference} comes to</caption>
              <thead>
                <tr>
                  <th>What it comes to</th>
                  <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Amount</th>
                </tr>
              </thead>
              <tbody>
                <Money label="Net of the receipts" minor={claim.totals.netMinor} currency={claim.currency} />
                <Money label="VAT reclaimed from the FTA" minor={claim.totals.recoverableVatMinor} currency={claim.currency} />
                <Money
                  label="VAT that cannot be reclaimed, so part of the cost"
                  minor={claim.totals.blockedVatMinor}
                  currency={claim.currency}
                />
                <Money label="Charged to expenses" minor={claim.totals.expenseMinor} currency={claim.currency} />
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row">Owed to {claim.employeeName}</th>
                  <td className="sw-num" data-testid="claim-detail-owed">
                    <Figure minor={owed} currency={claim.currency} zero="zero" colour={false} />
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          <div>
            <div className="sw-label">In the books</div>
            <ul className="mt-1 space-y-1">
              <li className="sw-sub">
                {claim.entryReference ? (
                  <>
                    Posted as <span className="sw-code">{claim.entryReference}</span> —{" "}
                    <Link href="/accounting/journals" className="sw-link">open the journals</Link>.
                  </>
                ) : (
                  "Nothing posted yet, so nothing on the income statement and nothing owed on 2200."
                )}
              </li>
              <li className="sw-sub">
                {claim.paidEntryReference ? (
                  <>Reimbursed as <span className="sw-code">{claim.paidEntryReference}</span>, out of the bank.</>
                ) : (
                  "Not reimbursed."
                )}
              </li>
              {claim.notes && <li className="sw-sub">Note on the claim: {claim.notes}</li>}
            </ul>
          </div>
        </div>
      </div>
    </>
  );
}

function Money({ label, minor, currency }: { label: string; minor: string; currency: string }) {
  return (
    <tr>
      <th scope="row" style={{ fontWeight: 400 }}>{label}</th>
      <td className="sw-num"><Figure minor={minor} currency={currency} zero="zero" colour={false} /></td>
    </tr>
  );
}

/**
 * What the approval queue holds against this claim.
 *
 * Rendered only when it has something to say. A claim in an entity with no
 * approval rule for expense claims is approved by the rules trivially, and a
 * panel announcing that on every claim would be noise standing exactly where
 * the sentence that matters has to be seen.
 *
 * The blockers are the server's own sentences, shown as they are: they name the
 * person, the date and the rule, and rewriting them here would produce a second
 * account of the same fact that could drift from the first.
 */
function ApprovalRound({ state, error, reference }: {
  state: ApprovalStateWire | null;
  error: string | null;
  reference: string;
}) {
  if (error) {
    return (
      <p className="sw-sub mb-3 max-w-[76ch]" data-testid="claim-approval-round">
        The approval queue could not be read ({error}), so whatever it holds against {reference} is not shown
        here. The approvals screen is the record.
      </p>
    );
  }
  if (!state) return null;
  if (!state.rejected && state.blockers.length === 0 && state.caveats.length === 0) return null;

  return (
    <div className="sw-note mb-3 max-w-[76ch]" data-testid="claim-approval-round">
      <div className="sw-label">In the approval queue</div>
      {state.blockers.map((b) => <p key={b} className="mt-1">{b}</p>)}
      {state.caveats.map((c) => <p key={c} className="mt-1">{c}</p>)}
      {state.rejected && (
        <p className="mt-1">
          Sending this claim back to draft and submitting it again does not clear that round — the two are
          separate records, and the queue keeps its decision until somebody withdraws it.{" "}
          <Link href="/accounting/approvals" className="sw-link">The approvals screen has the withdraw control</Link>
          , on this claim&rsquo;s row.
        </p>
      )}
    </div>
  );
}

/** The header of a draft claim: everything about it that is not a receipt. */
function ClaimHeaderForm({ claim, busy, onSave }: {
  claim: DetailClaim;
  busy: boolean;
  onSave: (patch: {
    reference: string; employeeCode: string; employeeName: string; claimedOn: string; notes: string | null;
  }) => void;
}) {
  const [f, setF] = React.useState({
    reference: claim.reference,
    employeeCode: claim.employeeCode,
    employeeName: claim.employeeName,
    claimedOn: claim.claimedOn,
    notes: claim.notes ?? "",
  });
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));

  const blocker =
    !f.reference.trim() ? "A claim cannot be left without a reference." :
    !f.employeeCode.trim() ? "Which employee?" :
    !f.employeeName.trim() ? "Name the employee being reimbursed." :
    !f.claimedOn ? "A claim date decides which period the expense lands in." :
    null;

  return (
    <div className="mt-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Reference">
          <input className="sw-input" value={f.reference} onChange={(e) => set("reference", e.target.value)} data-testid="claim-reference" />
        </Field>
        <Field label="Employee code" hint="The claimant's own code — what the self-approval check compares against.">
          <input className="sw-input" value={f.employeeCode} onChange={(e) => set("employeeCode", e.target.value)} />
        </Field>
        <Field label="Employee name">
          <input className="sw-input" value={f.employeeName} onChange={(e) => set("employeeName", e.target.value)} />
        </Field>
        <Field label="Claim date">
          <input type="date" className="sw-input" value={f.claimedOn} onChange={(e) => set("claimedOn", e.target.value)} />
        </Field>
        <Field label="Note" hint="Anything the approver should read that a receipt does not say.">
          <input className="sw-input" value={f.notes} onChange={(e) => set("notes", e.target.value)} />
        </Field>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="sw-btn sw-btn-primary"
          disabled={blocker !== null || busy}
          aria-disabled={blocker !== null || busy || undefined}
          data-testid="save-claim-header"
          onClick={() => onSave({
            reference: f.reference.trim(),
            employeeCode: f.employeeCode.trim(),
            employeeName: f.employeeName.trim(),
            claimedOn: f.claimedOn,
            notes: f.notes.trim() || null,
          })}
        >
          {busy ? "Saving…" : "Save the details"}
        </button>
        {blocker && <span className="sw-sub" role="status">{blocker}</span>}
      </div>
    </div>
  );
}
