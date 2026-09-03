"use client";

import * as React from "react";
import { api, ApiError, useEntityId, useLedgerQuery } from "@/components/ledger/use-ledger";
import { Figure, PageHead, Panel, ErrorNote, Loading, Empty } from "@/components/ledger/primitives";
import { parseAmount } from "@/lib/ledger/format";

interface RuleRow {
  id: string;
  entityId: string;
  subjectType: string;
  thresholdMinor: string;
  approversRequired: number;
  approverRole: string | null;
  approverUserId: string | null;
  active: boolean;
}
interface PendingRow {
  entityId: string;
  subjectType: string;
  subjectId: string;
  label: string;
  amountMinor: string;
  approvalsOutstanding: number;
  blockers: string[];
  waitingSince: string;
}
interface ApprovalsResponse {
  rules: RuleRow[];
  pending: PendingRow[];
}

/** The five things this ledger approves, as the server names them. */
const SUBJECTS: [string, string][] = [
  ["JOURNAL", "Journal entries"],
  ["BILL", "Supplier bills"],
  ["EXPENSE_CLAIM", "Expense claims"],
  ["PAYMENT", "Payments"],
  ["PAYROLL", "Payroll runs"],
];

const SUBJECT_ONE: Record<string, string> = {
  JOURNAL: "journal entry",
  BILL: "supplier bill",
  EXPENSE_CLAIM: "expense claim",
  PAYMENT: "payment",
  PAYROLL: "payroll run",
};

export default function ApprovalsPage() {
  const entityId = useEntityId();
  const { data, error, loading, reload } = useLedgerQuery<ApprovalsResponse>(
    entityId ? `/api/ledger/approvals?entityId=${entityId}` : null,
  );
  const [busy, setBusy] = React.useState<string | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [writing, setWriting] = React.useState(false);

  const act = async (key: string, body: Record<string, unknown>) => {
    setBusy(key); setErr(null); setMsg(null);
    try {
      const r = await api<Record<string, unknown>>("/api/ledger/approvals", {
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

  const judge = async (item: PendingRow, decision: "APPROVED" | "REJECTED") => {
    let reason: string | undefined;
    if (decision === "REJECTED") {
      const answer = window.prompt(`Why is ${item.label} being rejected? Whoever raised it sees this.`);
      if (answer === null) return;
      reason = answer;
    }
    const r = await act(`${item.subjectId}:${decision}`, {
      action: "decide",
      subjectType: item.subjectType,
      subjectId: item.subjectId,
      amountMinor: item.amountMinor,
      decision,
      reason,
    });
    if (!r) return;
    const state = r.state as { approved?: boolean; approvalsOutstanding?: number } | undefined;
    setMsg(
      decision === "REJECTED"
        ? `${item.label} rejected. It stays rejected until it is withdrawn and resubmitted.`
        : state?.approved
          ? `${item.label} now has every approval it needs.`
          : `${item.label} approved by you. It still needs ${state?.approvalsOutstanding ?? "another"} approval from somebody else.`,
    );
  };

  if (!entityId) return <Loading label="Choosing an entity…" />;
  const pending = data?.pending ?? [];
  const rules = data?.rules ?? [];

  return (
    <>
      <PageHead
        title="Approvals"
        sub="Who has to sign what, and above what amount. Thresholds add up rather than replace one another — a payment big enough to need a director still needs the everyday signature too — and nobody approves their own document."
        actions={
          <button type="button" className="sw-btn" onClick={() => setWriting((w) => !w)} data-testid="new-rule">
            {writing ? "Cancel" : "New rule"}
          </button>
        }
      />

      {err && <ErrorNote>{err}</ErrorNote>}
      {msg && <div className="sw-note mb-3" role="status" data-testid="approval-result">{msg}</div>}
      {error && <ErrorNote>{error}</ErrorNote>}

      {writing && (
        <NewRule
          busy={busy === "rule"}
          onSave={async (rule) => {
            const r = await act("rule", { action: "setRule", ...rule });
            if (r) { setWriting(false); setMsg("Rule saved. It applies from the next document raised."); }
          }}
        />
      )}

      {loading && !data && <Loading />}

      <Panel className="mb-4 overflow-hidden">
        <div className="flex flex-wrap items-baseline justify-between gap-2 px-3 py-2" style={{ borderBottom: "1px solid var(--sw-line)" }}>
          <span className="sw-label">Waiting on you</span>
          <span className="sw-sub" data-testid="queue-count">
            {pending.length} document{pending.length === 1 ? "" : "s"} · oldest first
          </span>
        </div>
        {data && pending.length === 0 ? (
          <div className="p-3">
            <Empty>Nothing is waiting on you. A document appears here when a rule names you or your role and you have not decided on it.</Empty>
          </div>
        ) : (
          <div className="sw-scroll">
            <table className="sw-table" data-testid="approval-queue">
              <caption className="sr-only">Documents waiting for your approval</caption>
              <thead>
                <tr>
                  <th style={{ width: "9rem" }}>Kind</th>
                  <th>Document</th>
                  <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Amount</th>
                  <th style={{ width: "7rem" }}>Waiting since</th>
                  <th>What is outstanding</th>
                  <th style={{ width: "11rem" }}><span className="sr-only">Decision</span></th>
                </tr>
              </thead>
              <tbody>
                {pending.map((p) => (
                  <tr key={`${p.subjectType}:${p.subjectId}`} data-testid={`queue-${p.subjectId}`}>
                    <td><span className="sw-chip">{SUBJECT_ONE[p.subjectType] ?? p.subjectType}</span></td>
                    <td className="max-w-0 truncate">{p.label}</td>
                    <td className="sw-num"><Figure minor={p.amountMinor} colour={false} /></td>
                    <td>{p.waitingSince.slice(0, 10)}</td>
                    <td className="sw-sub" style={{ whiteSpace: "normal" }}>{p.blockers.join(" ")}</td>
                    <td>
                      <span className="flex flex-wrap gap-1.5 py-1">
                        <button
                          type="button"
                          className="sw-btn sw-btn-sm sw-btn-primary"
                          disabled={busy === `${p.subjectId}:APPROVED`}
                          data-testid="approve"
                          onClick={() => judge(p, "APPROVED")}
                        >
                          {busy === `${p.subjectId}:APPROVED` ? "…" : "Approve"}
                        </button>
                        <button
                          type="button"
                          className="sw-btn sw-btn-sm"
                          disabled={busy === `${p.subjectId}:REJECTED`}
                          data-testid="reject"
                          onClick={() => judge(p, "REJECTED")}
                        >
                          Reject
                        </button>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {data && rules.length === 0 && (
        <Empty>
          No approval rules yet, so nothing in this entity needs a signature. Write one and it applies from the next
          document raised — it does not reach back over what has already been posted.
        </Empty>
      )}

      {rules.length > 0 && (
        <Panel className="overflow-hidden">
          <div className="px-3 py-2" style={{ borderBottom: "1px solid var(--sw-line)" }}>
            <span className="sw-label">Rules in force</span>
          </div>
          <div className="sw-scroll">
            <table className="sw-table" data-testid="rules-table">
              <caption className="sr-only">Approval rules in force for this entity</caption>
              <thead>
                <tr>
                  <th style={{ width: "11rem" }}>Applies to</th>
                  <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>From</th>
                  <th style={{ width: "7rem" }}>Approvers</th>
                  <th>Who may approve</th>
                  <th style={{ width: "8rem" }}><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {rules.map((r) => (
                  <tr key={r.id} data-testid={`rule-${r.id}`}>
                    <td>{SUBJECTS.find(([code]) => code === r.subjectType)?.[1] ?? r.subjectType}</td>
                    <td className="sw-num">
                      {r.thresholdMinor === "0"
                        ? <span className="sw-sub">every one</span>
                        : <Figure minor={r.thresholdMinor} colour={false} />}
                    </td>
                    <td>{r.approversRequired}</td>
                    <td className="max-w-0 truncate">
                      {r.approverUserId
                        ? <>{r.approverUserId}<span className="sw-sub"> · this person only</span></>
                        : <>{r.approverRole}<span className="sw-sub"> · anyone holding the role</span></>}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="sw-btn sw-btn-sm"
                        disabled={busy === `${r.id}:off`}
                        data-testid="deactivate-rule"
                        onClick={() => {
                          if (!window.confirm("Switch this rule off?\n\nDocuments already signed keep their approvals; new ones stop asking for this one.")) return;
                          void act(`${r.id}:off`, { action: "deactivateRule", ruleId: r.id });
                        }}
                      >
                        Switch off
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="sw-sub px-3 py-2" style={{ borderTop: "1px solid var(--sw-line)" }}>
            Every rule an amount clears is in force at once: a payment of 5,000.00 answers to the rule for every
            payment <em>and</em> the rule for large ones, not just the larger of the two. One person gets one decision
            per document, so a rule asking for two approvers means two people. Decisions are never edited &mdash; a
            change of mind is somebody else&rsquo;s decision, or a withdrawal and a fresh round, the same way a posted
            journal entry is corrected by a reversal.
          </p>
        </Panel>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ new rule */

function NewRule({ busy, onSave }: {
  busy: boolean;
  onSave: (rule: {
    subjectType: string; thresholdMinor: string; approversRequired: number;
    approverRole: string | null; approverUserId: string | null;
  }) => void;
}) {
  const [subjectType, setSubjectType] = React.useState("BILL");
  const [threshold, setThreshold] = React.useState("");
  const [approversRequired, setApproversRequired] = React.useState(1);
  const [who, setWho] = React.useState<"role" | "person">("role");
  const [role, setRole] = React.useState("");
  const [person, setPerson] = React.useState("");

  const thresholdMinor = threshold.trim() === "" ? 0n : parseAmount(threshold);
  const one = SUBJECT_ONE[subjectType] ?? "document";

  // The same refusals the server makes, said before the request rather than
  // after it. The server stays the authority; this is only courtesy.
  const blocker =
    thresholdMinor === null || thresholdMinor < 0n ? "The threshold has to be an amount, and not a negative one." :
    who === "role" && !role.trim() ? `Name the role that may approve ${one}s — a rule anyone can satisfy is not a control.` :
    who === "person" && !person.trim() ? `Name the person who may approve ${one}s — a rule anyone can satisfy is not a control.` :
    who === "person" && approversRequired > 1 ? "One person only ever has one approval. Name a role if several people have to sign." :
    null;

  return (
    <Panel className="mb-4 p-4">
      <div className="sw-label">New approval rule</div>
      <p className="sw-sub mt-1 max-w-[70ch]">
        A rule says who has to sign a kind of document from a given amount upwards. It adds to the rules already in
        force rather than replacing them, so writing one for large payments leaves the everyday one standing.
      </p>

      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Applies to">
          <select className="sw-select" value={subjectType} onChange={(e) => setSubjectType(e.target.value)} data-testid="rule-subject">
            {SUBJECTS.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
          </select>
        </Field>
        <Field label="From (blank means every one)">
          <input
            className="sw-input sw-cell-num"
            inputMode="decimal"
            value={threshold}
            onChange={(e) => setThreshold(e.target.value)}
            placeholder="1,000.00"
            data-testid="rule-threshold"
          />
        </Field>
        <Field label="Approvers needed">
          <select
            className="sw-select"
            value={approversRequired}
            onChange={(e) => setApproversRequired(Number(e.target.value))}
            data-testid="rule-approvers"
          >
            {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </Field>
        <Field label="Who may approve">
          <select className="sw-select" value={who} onChange={(e) => setWho(e.target.value as "role" | "person")} data-testid="rule-who">
            <option value="role">Anyone holding a role</option>
            <option value="person">One named person</option>
          </select>
        </Field>
        {who === "role" ? (
          <Field label="Role">
            <input className="sw-input" value={role} onChange={(e) => setRole(e.target.value)} placeholder="DIRECTOR" data-testid="rule-role" />
          </Field>
        ) : (
          <Field label="Person">
            <input className="sw-input" value={person} onChange={(e) => setPerson(e.target.value)} placeholder="user id" data-testid="rule-person" />
          </Field>
        )}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3" style={{ borderTop: "1px solid var(--sw-line)", paddingTop: "0.75rem" }}>
        <button
          type="button"
          className="sw-btn sw-btn-primary"
          disabled={blocker !== null || busy}
          aria-disabled={blocker !== null || busy || undefined}
          data-testid="save-rule"
          onClick={() => {
            if (blocker || thresholdMinor === null) return;
            onSave({
              subjectType,
              thresholdMinor: thresholdMinor.toString(),
              approversRequired,
              approverRole: who === "role" ? role.trim() : null,
              approverUserId: who === "person" ? person.trim() : null,
            });
          }}
        >
          {busy ? "Saving…" : "Save the rule"}
        </button>
        {blocker && <span className="sw-sub" role="status" data-testid="rule-blocker">{blocker}</span>}
        {!blocker && (
          <span className="sw-sub" data-testid="rule-summary">
            {approversRequired === 1 ? "One approval" : `${approversRequired} approvals`} from{" "}
            {who === "role" ? `anyone holding ${role.trim()}` : person.trim()} on{" "}
            {thresholdMinor === 0n ? `every ${one}` : <>{one}s of <Figure minor={thresholdMinor} colour={false} /> and above</>}.
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
