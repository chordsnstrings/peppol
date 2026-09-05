import { prisma } from "@/lib/server/prisma";
import { Prisma } from "@prisma/client";
import { fmtMinor } from "@/lib/ledger/format";
import { LedgerError } from "./post";
import { totalsOf } from "./expenses";

/**
 * Approval workflows — the general mechanism.
 *
 * expenses.ts already approves one thing in one way: a claim takes a single
 * approval, and the approver may not be the claimant. That is the right control
 * for a taxi receipt and the wrong one for a two-million-dirham payment run,
 * which a business wants two directors to sign. This file is the same idea with
 * the numbers written down — who may approve, how many of them, and above what
 * amount — for journals, bills, expense claims, payments and payroll alike.
 *
 * Four things are worth knowing before changing anything here.
 *
 * 1. Thresholds are cumulative, not bands. A payment of 500,000 clears the rule
 *    that applies to everything AND the rule that applies above 100,000, and
 *    both have to be satisfied. The naive reading — find the band the amount
 *    falls in, apply that one rule — quietly drops the everyday control at
 *    exactly the moment the amount gets big enough for it to matter.
 *
 * 2. Self-approval is refused. Everything else in this file is bookkeeping
 *    about who signed what; this is the part that stands between a payment and
 *    a withdrawal, and it is the one thing here that is not negotiable.
 *
 * 3. Decisions are append-only, the same principle as a posted journal entry.
 *    A person gets one decision per subject — the unique index on
 *    (orgId, subjectType, subjectId, decidedBy) enforces it — so a change of
 *    mind is somebody else's row, never an edit to an existing one. The single
 *    exception is withdraw(), and it is called out where it is defined.
 *
 * 4. Nothing here moves a document's own status. A claim is still approved
 *    through expenses.ts and posted through postClaim(); this records who else
 *    signed and what is still outstanding. assertApproved() is the join between
 *    the two — see the note on it for where a posting path should call it.
 */

/* ------------------------------------------------------------------ subjects */

export const SUBJECT_TYPES = ["JOURNAL", "BILL", "EXPENSE_CLAIM", "PAYMENT", "PAYROLL"] as const;
export type SubjectType = (typeof SUBJECT_TYPES)[number];

/** What a subject is called in a sentence somebody has to read and act on. */
const LABEL: Record<SubjectType, string> = {
  JOURNAL: "journal entry",
  BILL: "supplier bill",
  EXPENSE_CLAIM: "expense claim",
  PAYMENT: "payment",
  PAYROLL: "payroll run",
};

export type DecisionKind = "APPROVED" | "REJECTED";

/** Where a subject stands: nobody has refused it, and either it has enough approvals or it does not. */
export type SubjectState = "pending" | "approved" | "rejected";

/**
 * Every move a subject's approval can make, in one place — the same shape as
 * the claim machine in expenses.ts and the period machine in the periods route.
 * Anything not listed here is refused, so there is one statement of the
 * lifecycle to read and to argue with.
 *
 * The asymmetry is deliberate. A fully approved subject can still be rejected:
 * approvals are collected before the thing is posted, and somebody who spots
 * the problem in between has to be able to stop it. A rejected subject goes
 * nowhere at all — approving it does not out-vote the refusal, because
 * "rejected" is a statement about the version of the document that was refused.
 * The way past a rejection is to withdraw the decisions and ask again.
 */
const NEXT: Record<SubjectState, DecisionKind[]> = {
  pending: ["APPROVED", "REJECTED"],
  approved: ["REJECTED"],
  rejected: [],
};

/** Why the machine is shaped this way, said to whoever hit the wall. */
const WHY: Record<SubjectState, string> = {
  pending: "It is waiting for approvals, so it can be approved or rejected.",
  approved: "It already has every approval its rules ask for. It can still be rejected until it is posted, but another approval adds nothing.",
  rejected: "A rejection stands until the document is withdrawn and resubmitted — approving it now would not undo the refusal, it would only add a name beneath it.",
};

/* ------------------------------------------------------------------- helpers */

function minor(v: number | bigint | string | undefined | null, what: string): bigint {
  if (v === undefined || v === null || v === "") return 0n;
  if (typeof v === "number" && !Number.isInteger(v)) {
    throw new LedgerError(`${what} must be in whole minor units, got ${v}. Amounts are fils, never a decimal.`);
  }
  if (typeof v === "string" && !/^-?\d+$/.test(v.trim())) {
    throw new LedgerError(`${what} must be in whole minor units, got "${v}".`);
  }
  return BigInt(typeof v === "string" ? v.trim() : v);
}

/** Two people, by id — trimmed and case-insensitive, as in expenses.ts. */
const samePerson = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const key = (s: string) => s.trim().toLowerCase();

const abs = (v: bigint) => (v < 0n ? -v : v);
const aed = (v: bigint, currency = "AED") => `${currency} ${fmtMinor(v, currency, { zero: "zero" })}`;
const day = (d: Date) => d.toISOString().slice(0, 10);

const WORDS = ["no", "one", "two", "three", "four", "five"];
const approvals = (n: number) => `${WORDS[n] ?? n} more approval${n === 1 ? "" : "s"}`;

/** "DIRECTOR" reads as "a director" in a sentence; "OWNER" as "an owner". */
function roleAs(role: string): string {
  const words = role.trim().replace(/[_-]+/g, " ").toLowerCase();
  return `${/^[aeiou]/.test(words) ? "an" : "a"} ${words}`;
}

function assertSubjectType(v: string | undefined | null): SubjectType {
  const t = (v ?? "").trim().toUpperCase();
  if ((SUBJECT_TYPES as readonly string[]).includes(t)) return t as SubjectType;
  throw new LedgerError(
    `"${v ?? ""}" is not something this ledger approves. Approval rules cover ${SUBJECT_TYPES.join(", ")}.`,
  );
}

/* --------------------------------------------------------------------- rules */

export interface RuleRow {
  id: string;
  entityId: string;
  subjectType: SubjectType;
  /** The rule applies to amounts at or above this. Zero applies to everything. */
  thresholdMinor: bigint;
  approversRequired: number;
  approverRole: string | null;
  approverUserId: string | null;
  active: boolean;
}

const asRule = (r: {
  id: string; entityId: string; subjectType: string; thresholdMinor: bigint;
  approversRequired: number; approverRole: string | null; approverUserId: string | null; active: boolean;
}): RuleRow => ({ ...r, subjectType: r.subjectType as SubjectType });

/**
 * Write a rule, or replace the one that already says the same thing.
 *
 * "The same thing" is the subject, the threshold and the approver — because two
 * rules identical in those three would silently double what the business has to
 * collect, and nobody would be able to see why from the screen. So setRule is
 * idempotent on a rule's identity and only the count of approvers moves.
 *
 * The validation that matters is the last one: a rule that names neither a role
 * nor a person can be satisfied by anybody, including the person who raised the
 * document. That is not a control, it is a checkbox, and the database cannot
 * see the difference — so this does.
 */
export async function setRule(opts: {
  orgId: string;
  entityId: string;
  subjectType: SubjectType | string;
  thresholdMinor?: number | bigint | string;
  approversRequired?: number;
  approverRole?: string | null;
  approverUserId?: string | null;
}): Promise<RuleRow> {
  const subjectType = assertSubjectType(opts.subjectType);
  const what = LABEL[subjectType];

  const thresholdMinor = minor(opts.thresholdMinor ?? 0, `The threshold on a ${what} rule`);
  if (thresholdMinor < 0n) {
    throw new LedgerError(
      `A ${what} approval rule cannot have a negative threshold. Use zero for a rule that applies to every ${what}.`,
    );
  }

  const approversRequired = opts.approversRequired ?? 1;
  if (!Number.isInteger(approversRequired) || approversRequired < 1 || approversRequired > 5) {
    throw new LedgerError(
      `A ${what} approval rule must require between one and five approvers, not ${approversRequired}. ` +
        `A rule requiring nobody approves nothing, and one requiring more than five stops the business rather than controlling it.`,
    );
  }

  const approverRole = (opts.approverRole ?? "").trim() || null;
  const approverUserId = (opts.approverUserId ?? "").trim() || null;

  if (!approverRole && !approverUserId) {
    throw new LedgerError(
      `An approval rule for ${what}s has to name who may approve — a role, or one specific person. ` +
        `A rule anyone can satisfy is not a control: the person who raised the document would satisfy it themselves.`,
    );
  }
  if (approverRole && approverUserId) {
    throw new LedgerError(
      `An approval rule for ${what}s names both the role "${approverRole}" and the person ${approverUserId}. ` +
        `Pick one: a rule naming a person is satisfied only by that person, which would leave the role as decoration on the screen.`,
    );
  }
  if (approverUserId && approversRequired > 1) {
    throw new LedgerError(
      `A ${what} rule naming ${approverUserId} cannot require ${approversRequired} approvals — one person only ever has one, ` +
        `and the ledger refuses a second decision from the same person. Name a role if ${approversRequired} different people have to sign.`,
    );
  }

  // Reactivating a rule that was switched off is the same act as writing it,
  // and keeps the row (and anything that ever pointed at it) rather than
  // leaving a duplicate behind.
  const existing = await prisma.approvalRule.findFirst({
    where: { orgId: opts.orgId, entityId: opts.entityId, subjectType, thresholdMinor, approverRole, approverUserId },
  });

  const row = existing
    ? await prisma.approvalRule.update({
        where: { id: existing.id },
        data: { approversRequired, active: true },
      })
    : await prisma.approvalRule.create({
        data: {
          orgId: opts.orgId,
          entityId: opts.entityId,
          subjectType,
          thresholdMinor,
          approversRequired,
          approverRole,
          approverUserId,
          active: true,
        },
      });

  return asRule(row);
}

/** Every rule on the entity, strongest threshold first. Inactive ones on request. */
export async function listRules(opts: {
  orgId: string;
  entityId: string;
  subjectType?: SubjectType | string;
  includeInactive?: boolean;
}): Promise<RuleRow[]> {
  const subjectType = opts.subjectType ? assertSubjectType(opts.subjectType) : undefined;
  const rows = await prisma.approvalRule.findMany({
    where: {
      orgId: opts.orgId,
      entityId: opts.entityId,
      ...(subjectType ? { subjectType } : {}),
      ...(opts.includeInactive ? {} : { active: true }),
    },
    orderBy: [{ subjectType: "asc" }, { thresholdMinor: "desc" }, { createdAt: "asc" }],
  });
  return rows.map(asRule);
}

/**
 * Switch a rule off.
 *
 * Never a delete. The decisions already on file were collected because this
 * rule asked for them, and deleting the rule takes with it the answer to "why
 * did three people sign this?" — which is the question an auditor asks.
 */
export async function deactivateRule(opts: { orgId: string; ruleId: string }): Promise<RuleRow> {
  const rule = await prisma.approvalRule.findFirst({ where: { id: opts.ruleId, orgId: opts.orgId } });
  if (!rule) throw new LedgerError("That approval rule does not exist.");
  if (!rule.active) return asRule(rule);
  const row = await prisma.approvalRule.update({ where: { id: rule.id }, data: { active: false } });
  return asRule(row);
}

/**
 * Order the rules an amount has to satisfy, most specific first.
 *
 * Most specific means: the highest threshold first (a rule about large payments
 * says more than a rule about all of them), and within a threshold, a rule
 * naming one person before a rule naming a role.
 */
function applicable(rules: RuleRow[], amountMinor: bigint): RuleRow[] {
  // Size, not sign. A refund of 500,000 moves exactly as much money as a
  // payment of 500,000 and deserves the same signatures.
  const size = abs(amountMinor);
  return rules
    .filter((r) => r.active && r.thresholdMinor <= size)
    .sort((a, b) => {
      if (a.thresholdMinor !== b.thresholdMinor) return a.thresholdMinor > b.thresholdMinor ? -1 : 1;
      const aNamed = a.approverUserId ? 0 : 1;
      const bNamed = b.approverUserId ? 0 : 1;
      if (aNamed !== bNamed) return aNamed - bNamed;
      if (a.approversRequired !== b.approversRequired) return b.approversRequired - a.approversRequired;
      return a.id < b.id ? -1 : 1;
    });
}

/**
 * Every ACTIVE rule an amount has to satisfy.
 *
 * THRESHOLDS ARE CUMULATIVE, NOT EXCLUSIVE. An amount of 500,000 meets a rule
 * at 0 and a rule at 100,000, and this returns both, because a finance team
 * that wrote "everything needs a manager" and "over 100,000 needs two
 * directors" means both sentences at once. The tempting implementation — sort
 * the rules and return the highest band the amount falls into — reads as
 * "bigger amounts replace the everyday control", which is precisely backwards:
 * it removes the manager's signature from the one payment most worth watching.
 */
export async function rulesFor(opts: {
  orgId: string;
  entityId: string;
  subjectType: SubjectType | string;
  amountMinor: number | bigint | string;
}): Promise<RuleRow[]> {
  const subjectType = assertSubjectType(opts.subjectType);
  const amount = minor(opts.amountMinor, `The amount on a ${LABEL[subjectType]}`);
  const rows = await prisma.approvalRule.findMany({
    where: { orgId: opts.orgId, entityId: opts.entityId, subjectType, active: true },
  });
  return applicable(rows.map(asRule), amount);
}

/* --------------------------------------------------------------------- state */

export interface DecisionRow {
  id: string;
  entityId: string;
  subjectType: SubjectType;
  subjectId: string;
  decision: DecisionKind;
  decidedBy: string;
  decidedAt: Date;
  amountMinor: bigint | null;
  reason: string | null;
}

export interface AppliedRule extends RuleRow {
  /** Whether the decisions on file already answer this rule. */
  satisfied: boolean;
  /** How many approvals this one rule is still short of. */
  missing: number;
  /** Who, of the people on file, counted towards it. */
  satisfiedBy: string[];
}

export interface ApprovalState {
  entityId: string;
  subjectType: SubjectType;
  subjectId: string;
  amountMinor: bigint;
  state: SubjectState;
  approved: boolean;
  rejected: boolean;
  rules: AppliedRule[];
  decisions: DecisionRow[];
  /** Distinct people whose approval counts towards this amount. */
  approvers: string[];
  /** The most any single rule is still short by — see the note below. */
  approvalsOutstanding: number;
  rejection: { by: string; at: Date; reason: string | null } | null;
  /** What is still outstanding, in sentences somebody can act on. */
  blockers: string[];
}

const asDecision = (d: {
  id: string; entityId: string; subjectType: string; subjectId: string; decision: string;
  decidedBy: string; decidedAt: Date; amountMinor: bigint | null; reason: string | null;
}): DecisionRow => ({
  ...d,
  subjectType: d.subjectType as SubjectType,
  decision: d.decision as DecisionKind,
});

/**
 * Work out where a subject stands from the rules and the decisions on file.
 *
 * Pure, so that the queue can settle a hundred subjects from two queries rather
 * than two hundred, and so the arithmetic can be read without a database in
 * front of you.
 */
function computeState(input: {
  entityId: string;
  subjectType: SubjectType;
  subjectId: string;
  amountMinor: bigint;
  currency?: string;
  rules: RuleRow[];
  decisions: DecisionRow[];
}): ApprovalState {
  const { subjectType, amountMinor } = input;
  const what = LABEL[subjectType];
  const currency = input.currency ?? "AED";
  const decisions = [...input.decisions].sort((a, b) => a.decidedAt.getTime() - b.decidedAt.getTime());

  const rejectionRow = decisions.find((d) => d.decision === "REJECTED") ?? null;
  const approvedRows = decisions.filter((d) => d.decision === "APPROVED");

  // An approval covers the amount it was shown. If the document has changed
  // since — a bill re-keyed from 1,000 to 50,000 after the manager signed it —
  // the signature on file is for a document that no longer exists, so it counts
  // for nothing and the state says so out loud. This is the failure mode an
  // approval workflow exists to catch, and it is invisible without the amount
  // being written on the decision at the time it was made.
  const stale = approvedRows.filter((d) => d.amountMinor !== null && d.amountMinor !== amountMinor);
  const counting = approvedRows.filter((d) => !stale.includes(d));
  const pool = new Set(counting.map((d) => key(d.decidedBy)));

  const rules: AppliedRule[] = input.rules.map((r) => {
    if (r.approverUserId) {
      const has = pool.has(key(r.approverUserId));
      return { ...r, satisfied: has, missing: has ? 0 : 1, satisfiedBy: has ? [r.approverUserId] : [] };
    }
    const missing = Math.max(0, r.approversRequired - pool.size);
    return {
      ...r,
      satisfied: missing === 0,
      missing,
      satisfiedBy: counting.slice(0, r.approversRequired).map((d) => d.decidedBy),
    };
  });

  // What is outstanding is the largest shortfall, not the sum of them. One
  // person can answer more than one rule at a time — a director approving a
  // large payment satisfies "everything needs a signature" in the same stroke —
  // so adding the shortfalls up would demand signatures nobody's policy asks
  // for, and the screen would tell people to chase approvals that do not exist.
  const approvalsOutstanding = rules.reduce((m, r) => Math.max(m, r.missing), 0);

  const rejected = rejectionRow !== null;
  const approved = !rejected && rules.every((r) => r.satisfied);

  const blockers: string[] = [];
  if (rejectionRow) {
    blockers.push(
      `This ${what} was rejected by ${rejectionRow.decidedBy} on ${day(rejectionRow.decidedAt)}` +
        `${rejectionRow.reason ? ` — "${rejectionRow.reason}"` : ""}. ` +
        `A rejection stands until the ${what} is withdrawn and resubmitted; a later approval does not undo it.`,
    );
  }
  if (stale.length > 0) {
    const at = stale[0].amountMinor as bigint;
    blockers.push(
      `${stale.length === 1 ? "An approval" : `${WORDS[stale.length] ?? stale.length} approvals`} on file ` +
        `${stale.length === 1 ? "was" : "were"} given when this ${what} was ${aed(at, currency)}, and it is now ` +
        `${aed(amountMinor, currency)}. An approval covers the amount it was shown, so it has to be approved again at the new figure.`,
    );
  }
  for (const r of rules) {
    if (r.satisfied) continue;
    const scope = r.thresholdMinor === 0n
      ? `every ${what}`
      : `${what}s of ${aed(r.thresholdMinor, currency)} and above`;
    if (r.approverUserId) {
      blockers.push(
        `This ${what} of ${aed(amountMinor, currency)} needs the approval of ${r.approverUserId}, ` +
          `who the rule for ${scope} names; they have not approved it yet.`,
      );
    } else {
      blockers.push(
        `This ${what} of ${aed(amountMinor, currency)} needs ${approvals(r.missing)} from ` +
          `${roleAs(r.approverRole ?? "approver")} — the rule for ${scope} requires ` +
          `${WORDS[r.approversRequired] ?? r.approversRequired}.`,
      );
    }
  }

  return {
    entityId: input.entityId,
    subjectType,
    subjectId: input.subjectId,
    amountMinor,
    state: rejected ? "rejected" : approved ? "approved" : "pending",
    approved,
    rejected,
    rules,
    decisions,
    approvers: counting.map((d) => d.decidedBy),
    approvalsOutstanding,
    rejection: rejectionRow
      ? { by: rejectionRow.decidedBy, at: rejectionRow.decidedAt, reason: rejectionRow.reason }
      : null,
    blockers,
  };
}

/**
 * Where one subject stands: the rules that apply to it, who has decided, how
 * many approvals are still outstanding, and what is stopping it in words.
 *
 * A subject that meets no rule at all comes back approved with no blockers —
 * that is the honest answer for a 50-dirham taxi fare in a business whose
 * lowest rule starts at 1,000, and it is why the guard below can be called
 * unconditionally from a posting path.
 */
export async function approvalState(opts: {
  orgId: string;
  entityId: string;
  subjectType: SubjectType | string;
  subjectId: string;
  amountMinor: number | bigint | string;
  currency?: string;
}): Promise<ApprovalState> {
  const subjectType = assertSubjectType(opts.subjectType);
  const subjectId = (opts.subjectId ?? "").trim();
  if (!subjectId) throw new LedgerError(`Which ${LABEL[subjectType]}? An approval state needs the id of the thing being approved.`);
  const amountMinor = minor(opts.amountMinor, `The amount on ${LABEL[subjectType]} ${subjectId}`);

  const [ruleRows, decisionRows] = await Promise.all([
    prisma.approvalRule.findMany({
      where: { orgId: opts.orgId, entityId: opts.entityId, subjectType, active: true },
    }),
    // The unique index is (orgId, subjectType, subjectId, decidedBy) — org-wide,
    // not per entity — so entityId would narrow nothing here. It is carried on
    // the row so the queue can be read one entity at a time.
    prisma.approvalDecision.findMany({ where: { orgId: opts.orgId, subjectType, subjectId } }),
  ]);

  return computeState({
    entityId: opts.entityId,
    subjectType,
    subjectId,
    amountMinor,
    currency: opts.currency,
    rules: applicable(ruleRows.map(asRule), amountMinor),
    decisions: decisionRows.map(asDecision),
  });
}

/* ------------------------------------------------------------------ deciding */

export interface DecideResult {
  decision: DecisionRow;
  /** Where the subject stands now that this decision is on file. */
  state: ApprovalState;
}

/**
 * Record one person's decision on one subject.
 *
 * The order of the checks is the order of the arguments somebody would have
 * with you about them:
 *
 *   - self-approval, refused outright and explained;
 *   - one decision per person, refused with a sentence rather than a unique
 *     constraint, because "duplicate key value violates unique constraint" does
 *     not tell an approver that they have already signed this;
 *   - a rejection needs a reason;
 *   - and the state machine, which is what makes a rejection stick.
 *
 * The row that comes out is never edited afterwards. A change of mind is
 * another person's row, or a withdrawal and a fresh round — the same rule that
 * governs a posted journal entry, for the same reason.
 */
export async function decide(opts: {
  orgId: string;
  entityId: string;
  subjectType: SubjectType | string;
  subjectId: string;
  decision: DecisionKind | string;
  decidedBy: string;
  amountMinor: number | bigint | string;
  reason?: string | null;
  /** Who raised the thing. Given, it is what makes self-approval detectable. */
  submittedBy?: string | null;
  currency?: string;
}): Promise<DecideResult> {
  const subjectType = assertSubjectType(opts.subjectType);
  const what = LABEL[subjectType];
  const subjectId = (opts.subjectId ?? "").trim();
  if (!subjectId) throw new LedgerError(`Which ${what}? A decision has to say what it is about.`);

  const decision = (opts.decision ?? "").trim().toUpperCase();
  if (decision !== "APPROVED" && decision !== "REJECTED") {
    throw new LedgerError(`"${opts.decision}" is not a decision. A decision is APPROVED or REJECTED.`);
  }

  const decidedBy = (opts.decidedBy ?? "").trim();
  if (!decidedBy) {
    throw new LedgerError(
      `Deciding on ${what} ${subjectId} needs the identity of whoever decided. An approval nobody signed is a checkbox, not a control.`,
    );
  }

  const amountMinor = minor(opts.amountMinor, `The amount on ${what} ${subjectId}`);
  const reason = (opts.reason ?? "").trim() || null;
  const submittedBy = (opts.submittedBy ?? "").trim() || null;

  if (decision === "REJECTED" && !reason) {
    throw new LedgerError(
      `Rejecting ${what} ${subjectId} needs a reason. Whoever raised it has to know what to fix, or they will simply send it back unchanged.`,
    );
  }

  // The control that matters. Everything else here is a record of who signed;
  // this is the part that stops a person moving the company's money to
  // themselves and countersigning it. It bars approving only — refusing your
  // own document costs the business nothing and is how somebody withdraws it.
  //
  // submittedBy and decidedBy have to come from the same namespace for the
  // comparison to mean anything: an employee code tested against a user id is
  // never equal, and the check would pass every time while protecting nothing.
  if (decision === "APPROVED" && submittedBy && samePerson(submittedBy, decidedBy)) {
    throw new LedgerError(
      `${decidedBy} raised ${what} ${subjectId} and cannot approve it. ` +
        `An approval has to come from somebody other than the person who raised the document — self-approval is the one thing ` +
        `standing between an approval workflow and a formality.`,
    );
  }

  const state = await approvalState({
    orgId: opts.orgId, entityId: opts.entityId, subjectType, subjectId, amountMinor, currency: opts.currency,
  });

  const mine = state.decisions.find((d) => samePerson(d.decidedBy, decidedBy));
  if (mine) {
    throw new LedgerError(
      `${decidedBy} already ${mine.decision === "APPROVED" ? "approved" : "rejected"} ${what} ${subjectId} on ${day(mine.decidedAt)}. ` +
        `One person gets one decision per document: without that, a rule asking for two approvers would be satisfied twice over by ` +
        `the same person. ${state.approvalsOutstanding > 0 ? `It still needs ${approvals(state.approvalsOutstanding)} from somebody else.` : ""}`.trim(),
    );
  }

  const allowed = NEXT[state.state] ?? [];
  if (!allowed.includes(decision)) {
    throw new LedgerError(`${what.charAt(0).toUpperCase()}${what.slice(1)} ${subjectId} cannot be ${decision.toLowerCase()}. ${WHY[state.state]}`);
  }

  let row;
  try {
    row = await prisma.approvalDecision.create({
      data: {
        orgId: opts.orgId,
        entityId: opts.entityId,
        subjectType,
        subjectId,
        decision,
        decidedBy,
        amountMinor,
        reason,
      },
    });
  } catch (e) {
    // Two approvers clicking at once. The unique index is the guarantee; the
    // check above is only the good sentence, so it has to be said here too.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      throw new LedgerError(
        `${decidedBy} has already decided on ${what} ${subjectId}. One person gets one decision per document.`,
      );
    }
    throw e;
  }

  return {
    decision: asDecision(row),
    state: await approvalState({
      orgId: opts.orgId, entityId: opts.entityId, subjectType, subjectId, amountMinor, currency: opts.currency,
    }),
  };
}

/**
 * Clear the decisions on a subject so a fresh round can start.
 *
 * This is the ONLY place in this file that removes anything, and it exists
 * because of a corner the schema paints us into: one person gets one row per
 * subject, so after a rejection the same approver physically cannot record the
 * approval that follows a fix. Something has to give, and a withdrawal is the
 * honest version of it — an explicit act, with a reason, that says the round is
 * over and the document goes back to whoever raised it.
 *
 * It returns what it cleared so the caller can write it wherever it keeps its
 * history. If the schema ever gains a round number on the decision, this
 * becomes an insert like everything else and the delete goes away.
 */
export async function withdraw(opts: {
  orgId: string;
  subjectType: SubjectType | string;
  subjectId: string;
  withdrawnBy: string;
  reason: string;
}): Promise<{ cleared: DecisionRow[] }> {
  const subjectType = assertSubjectType(opts.subjectType);
  const what = LABEL[subjectType];
  const subjectId = (opts.subjectId ?? "").trim();
  if (!subjectId) throw new LedgerError(`Which ${what}? A withdrawal has to say what it is about.`);
  if (!(opts.withdrawnBy ?? "").trim()) {
    throw new LedgerError(`Withdrawing ${what} ${subjectId} needs the identity of whoever withdrew it.`);
  }
  if (!(opts.reason ?? "").trim()) {
    throw new LedgerError(
      `Withdrawing ${what} ${subjectId} needs a reason. Withdrawal throws away the approvals already collected, so the record has to say why.`,
    );
  }

  const cleared = await prisma.approvalDecision.findMany({
    where: { orgId: opts.orgId, subjectType, subjectId },
  });
  if (cleared.length === 0) {
    throw new LedgerError(`There are no decisions on ${what} ${subjectId} to withdraw.`);
  }
  await prisma.approvalDecision.deleteMany({ where: { orgId: opts.orgId, subjectType, subjectId } });
  return { cleared: cleared.map(asDecision) };
}

/* --------------------------------------------------------------------- guard */

/**
 * The guard a posting path calls before it writes to the ledger.
 *
 * CALL SITES. The call is made from each posting path rather than from here,
 * because those files own their own control flow and know their own amount and
 * document id — which is all this needs. Where they stand:
 *
 *   - postClaim() in expenses.ts, after its own approved-status check — wired;
 *   - postBill() in ap.ts, before post() — wired;
 *   - postSupplierPayment() in ap.ts, before post() — wired;
 *   - the manual journal route (api/ledger/journals), which names the subject
 *     the decisions were collected against — wired;
 *   - the payroll run in payroll.ts, before it posts the WPS batch — NOT yet
 *     wired, so payroll rules configured on the screen do not bind;
 *   - releaseRun() in payment-runs.ts, which posts a batch of supplier
 *     payments — NOT wired either, and see the note in that file for why it
 *     keeps a control of its own regardless.
 *
 * Where no rule covers the amount it returns quietly, so it is safe to call on
 * every posting rather than only on the large ones — a guard people remember to
 * call only sometimes is a guard that protects nothing. Keep this list honest:
 * a posting path missing from it is a rule an organisation can see on its
 * approvals screen and watch every document sail past.
 */
export async function assertApproved(opts: {
  orgId: string;
  entityId: string;
  subjectType: SubjectType | string;
  subjectId: string;
  amountMinor: number | bigint | string;
  /** The document number, when there is one, so the message names it. */
  reference?: string;
  currency?: string;
}): Promise<ApprovalState> {
  const state = await approvalState(opts);
  if (state.approved) return state;

  const what = LABEL[state.subjectType];
  const named = opts.reference ? `${what.charAt(0).toUpperCase()}${what.slice(1)} ${opts.reference}` : `This ${what}`;
  throw new LedgerError(`${named} has not been approved and cannot be posted. ${state.blockers.join(" ")}`);
}

/* --------------------------------------------------------------------- queue */

export interface PendingItem {
  entityId: string;
  subjectType: SubjectType;
  subjectId: string;
  /** What to call it on screen — a document reference where the ledger has one. */
  label: string;
  amountMinor: bigint;
  approvalsOutstanding: number;
  blockers: string[];
  /** Since when it has been sitting there, so the queue can be worked oldest first. */
  waitingSince: Date;
}

/** A candidate the queue considers, before the rules are applied to it. */
interface Candidate {
  entityId: string;
  subjectType: SubjectType;
  subjectId: string;
  label: string;
  amountMinor: bigint;
  waitingSince: Date;
  submittedBy: string | null;
}

/**
 * What is waiting on this person.
 *
 * A queue, not a search box: an approver should open the screen and see the
 * work, not have to know the reference of a bill somebody else keyed. Two
 * things can put a subject in it —
 *
 *   - a submitted expense claim, which is the one document type this ledger
 *     holds in a table of its own with an amount on it; and
 *   - any subject somebody has already decided on and which is not finished,
 *     which is how a part-approved bill or payment finds its second signature.
 *
 * A subject nobody has touched, in a subledger with no table here (a payment
 * run, say), cannot appear until its first decision is recorded — that is a
 * real gap, and the fix is for those modules to record the request, not for
 * this one to guess.
 *
 * `role` is the caller's, from the session. Where it is not given, the org
 * membership is read; where there is none, role-based rules simply do not
 * match, because showing every pending document to a person whose role nobody
 * can establish is how a queue becomes noise.
 */
export async function pendingFor(opts: {
  orgId: string;
  userId: string;
  role?: string | null;
  entityId?: string;
  subjectType?: SubjectType | string;
}): Promise<PendingItem[]> {
  const userId = (opts.userId ?? "").trim();
  if (!userId) throw new LedgerError("An approval queue needs to know whose it is.");
  const subjectType = opts.subjectType ? assertSubjectType(opts.subjectType) : undefined;

  const role =
    opts.role === undefined
      ? (await prisma.membership.findUnique({
          where: { userId_orgId: { userId, orgId: opts.orgId } },
          select: { role: true },
        }))?.role ?? null
      : (opts.role ?? "").trim() || null;

  const [ruleRows, decisionRows, claims] = await Promise.all([
    prisma.approvalRule.findMany({
      where: { orgId: opts.orgId, active: true, ...(opts.entityId ? { entityId: opts.entityId } : {}), ...(subjectType ? { subjectType } : {}) },
    }),
    // Bounded: what is in flight, not the history. A subject with every
    // approval on it is filtered out below rather than fetched separately.
    prisma.approvalDecision.findMany({
      where: { orgId: opts.orgId, ...(opts.entityId ? { entityId: opts.entityId } : {}), ...(subjectType ? { subjectType } : {}) },
      orderBy: [{ decidedAt: "asc" }],
      take: 5000,
    }),
    subjectType && subjectType !== "EXPENSE_CLAIM"
      ? Promise.resolve([])
      : prisma.expenseClaim.findMany({
          where: { orgId: opts.orgId, status: "submitted", ...(opts.entityId ? { entityId: opts.entityId } : {}) },
          include: { lines: { select: { netMinor: true, vatMinor: true, vatRecoverable: true } } },
          orderBy: [{ submittedAt: "asc" }],
          take: 500,
        }),
  ]);

  const rules = ruleRows.map(asRule);
  const decisions = decisionRows.map(asDecision);

  const bySubject = new Map<string, DecisionRow[]>();
  for (const d of decisions) {
    const k = `${d.subjectType}:${d.subjectId}`;
    const list = bySubject.get(k);
    if (list) list.push(d);
    else bySubject.set(k, [d]);
  }

  const candidates = new Map<string, Candidate>();
  for (const c of claims) {
    candidates.set(`EXPENSE_CLAIM:${c.id}`, {
      entityId: c.entityId,
      subjectType: "EXPENSE_CLAIM",
      subjectId: c.id,
      label: `${c.reference} — ${c.employeeName}`,
      amountMinor: totalsOf(c.lines).totalMinor,
      waitingSince: c.submittedAt ?? c.createdAt,
      // The claimant, in the claim's own namespace. Same caveat as expenses.ts:
      // it only bars self-approval if employee codes and user ids are the same
      // thing in this deployment.
      submittedBy: c.employeeCode,
    });
  }
  for (const [k, rows] of bySubject) {
    if (candidates.has(k)) continue;
    const first = rows[0];
    // The amount as last decided on. A decision carries the figure it was shown,
    // which is the only amount this module knows for a subject with no table here.
    const withAmount = [...rows].reverse().find((r) => r.amountMinor !== null);
    if (!withAmount) continue;
    candidates.set(k, {
      entityId: first.entityId,
      subjectType: first.subjectType,
      subjectId: first.subjectId,
      label: first.subjectId,
      amountMinor: withAmount.amountMinor as bigint,
      waitingSince: first.decidedAt,
      submittedBy: null,
    });
  }

  const out: PendingItem[] = [];
  for (const c of candidates.values()) {
    if (subjectType && c.subjectType !== subjectType) continue;
    if (opts.entityId && c.entityId !== opts.entityId) continue;

    const state = computeState({
      entityId: c.entityId,
      subjectType: c.subjectType,
      subjectId: c.subjectId,
      amountMinor: c.amountMinor,
      rules: applicable(rules.filter((r) => r.entityId === c.entityId && r.subjectType === c.subjectType), c.amountMinor),
      decisions: bySubject.get(`${c.subjectType}:${c.subjectId}`) ?? [],
    });

    if (state.approved || state.rejected) continue;
    // Already had their say — the unique index would refuse a second one anyway.
    if (state.decisions.some((d) => samePerson(d.decidedBy, userId))) continue;
    // Their own document is not waiting on them; nobody approves their own work.
    if (c.submittedBy && samePerson(c.submittedBy, userId)) continue;

    const waitingOnThem = state.rules.some(
      (r) =>
        !r.satisfied &&
        (r.approverUserId ? samePerson(r.approverUserId, userId) : role !== null && samePerson(r.approverRole ?? "", role)),
    );
    if (!waitingOnThem) continue;

    out.push({
      entityId: c.entityId,
      subjectType: c.subjectType,
      subjectId: c.subjectId,
      label: c.label,
      amountMinor: c.amountMinor,
      approvalsOutstanding: state.approvalsOutstanding,
      blockers: state.blockers,
      waitingSince: c.waitingSince,
    });
  }

  // Oldest first: a queue worked newest-first is how the awkward one never gets
  // done. Ties break on the larger amount, which is the one costing money to sit.
  return out.sort((a, b) => {
    const t = a.waitingSince.getTime() - b.waitingSince.getTime();
    if (t !== 0) return t;
    return a.amountMinor > b.amountMinor ? -1 : a.amountMinor < b.amountMinor ? 1 : 0;
  });
}

export { NEXT as APPROVAL_TRANSITIONS, LABEL as SUBJECT_LABELS };
