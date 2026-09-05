import { prisma } from "@/lib/server/prisma";
import { Prisma } from "@prisma/client";
import { fmtMinor, exponentOf } from "@/lib/ledger/format";
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
 *    a withdrawal, and it is the one thing here that is not negotiable. Who
 *    raised a subject is therefore read from the register the subject lives in
 *    rather than taken from whoever is calling — see `subjectFacts` — because a
 *    bar that arms only when the caller remembers to name the raiser is not a
 *    bar, and for four of the five subjects nobody ever remembered.
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
  /**
   * The roles this person held at the moment they decided.
   *
   * Null for a decision recorded before the column existed. That is treated as
   * unverified rather than as failing — see the note on `computeState` — and
   * the state says which it is rather than passing one off as the other.
   */
  decidedByRoles: string[] | null;
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
  /**
   * True of the approval and not a reason it cannot proceed — a check that was
   * waived rather than passed. Kept apart from `blockers` so a document nothing
   * is waiting on does not report something outstanding.
   */
  caveats: string[];
  /**
   * The figure the THRESHOLDS were tested against, in the book's own currency.
   *
   * Equal to `amountMinor` for a document in the functional currency, which is
   * most of them. Different for a foreign one, and the difference is the point:
   * a EUR 20,000 bill is roughly AED 80,000, and testing 20,000 against a
   * threshold written in dirhams let four fifths of the money past the rule.
   */
  matchedOnMinor: bigint;
  /** The currency the thresholds are written in — the book's. */
  thresholdCurrency: string;
}

const asDecision = (d: {
  id: string; entityId: string; subjectType: string; subjectId: string; decision: string;
  decidedBy: string; decidedAt: Date; amountMinor: bigint | null; reason: string | null;
  decidedByRoles?: string | null;
}): DecisionRow => ({
  ...d,
  subjectType: d.subjectType as SubjectType,
  decision: d.decision as DecisionKind,
  // Stored comma-separated because a person can hold more than one role and a
  // rule asks about one of them. An empty string is a decision taken by
  // somebody who held no role, which is a different fact from a decision that
  // predates the column.
  decidedByRoles:
    d.decidedByRoles === undefined || d.decidedByRoles === null
      ? null
      : d.decidedByRoles.split(",").map((r) => r.trim()).filter(Boolean),
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
  /**
   * The same money in the book's currency, which is the currency the
   * thresholds are in. Defaults to `amountMinor` — right whenever the document
   * is in the functional currency, and wrong in exactly the case this argument
   * exists for.
   */
  matchMinor?: bigint;
  /** The book's currency, for wording a threshold in the units it is written in. */
  thresholdCurrency?: string;
  /** Set when the document is foreign and no rate is on file to convert it. */
  rateMissing?: { currency: string; asOf: string } | null;
  rules: RuleRow[];
  decisions: DecisionRow[];
}): ApprovalState {
  const { subjectType, amountMinor } = input;
  const what = LABEL[subjectType];
  const currency = input.currency ?? "AED";
  const matchMinor = input.matchMinor ?? amountMinor;
  const thresholdCurrency = input.thresholdCurrency ?? currency;
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

  /*
   * A rule naming a ROLE has to be answered by people who held it.
   *
   * This counted signatures and compared the count with `approversRequired`,
   * without ever asking what the signatories were. "Bills over 50,000 need two
   * directors" was therefore satisfied by any two people who could reach the
   * endpoint — a rule naming a PERSON was enforced and a rule naming a role was
   * a tally. That is the half of the policy a business actually writes, because
   * naming individuals in a rule means rewriting the rules whenever somebody
   * leaves.
   *
   * The role is read off the decision, where it was recorded at the moment it
   * was made, and never from the assignments as they stand now. Somebody who
   * was a director in March and is not one today still signed that bill as a
   * director, and re-reading the assignments would silently un-approve posted
   * documents whenever a person changes job.
   *
   * A decision from before the roles were recorded counts, and is reported as
   * unverified rather than as a pass. Failing them instead would block every
   * part-approved document in flight the day this shipped, and a control that
   * breaks on installation is a control that gets taken out again.
   */
  const holdsRole = (d: DecisionRow, role: string) =>
    d.decidedByRoles === null || d.decidedByRoles.some((r) => samePerson(r, role));

  const unverified = counting.filter((d) => d.decidedByRoles === null);

  const rules: AppliedRule[] = input.rules.map((r) => {
    if (r.approverUserId) {
      const has = pool.has(key(r.approverUserId));
      return { ...r, satisfied: has, missing: has ? 0 : 1, satisfiedBy: has ? [r.approverUserId] : [] };
    }
    const eligible = r.approverRole ? counting.filter((d) => holdsRole(d, r.approverRole as string)) : counting;
    const distinct = new Set(eligible.map((d) => key(d.decidedBy)));
    const missing = Math.max(0, r.approversRequired - distinct.size);
    return {
      ...r,
      satisfied: missing === 0,
      missing,
      satisfiedBy: eligible.slice(0, r.approversRequired).map((d) => d.decidedBy),
    };
  });

  // What is outstanding is the largest shortfall, not the sum of them. One
  // person can answer more than one rule at a time — a director approving a
  // large payment satisfies "everything needs a signature" in the same stroke —
  // so adding the shortfalls up would demand signatures nobody's policy asks
  // for, and the screen would tell people to chase approvals that do not exist.
  const approvalsOutstanding = rules.reduce((m, r) => Math.max(m, r.missing), 0);

  const rejected = rejectionRow !== null;
  const rateMissing = input.rateMissing ?? null;
  const approved = !rejected && rateMissing === null && rules.every((r) => r.satisfied);

  const blockers: string[] = [];
  /** True of the approval, but not a reason it cannot proceed. */
  const caveats: string[] = [];
  if (rateMissing) {
    blockers.push(
      `This ${what} is in ${rateMissing.currency} and the approval limits are written in ${thresholdCurrency}, ` +
        `but no ${rateMissing.currency} rate is on file at ${rateMissing.asOf}. Comparing the two figures as they ` +
        `stand would test ${aed(amountMinor, currency)} against a limit in a different unit, which is how a ` +
        `foreign document four times the size of the threshold passes a rule written to stop it. Record the rate ` +
        `on the revaluation screen and this answers itself.`,
    );
  }
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
  /*
   * A caveat, not a blocker.
   *
   * A signature recorded before this ledger kept the approver's role counts
   * towards a role rule without the role having been checked, and the reader
   * has to know that a check was waived rather than passed. But it does not
   * stop anything — the subject can be perfectly approved and still carry it —
   * and putting it in `blockers` would mean a document that nothing is waiting
   * on reported something outstanding.
   */
  if (unverified.length > 0 && rules.some((r) => r.approverRole && !r.approverUserId)) {
    caveats.push(
      `${unverified.length === 1 ? "One approval" : `${WORDS[unverified.length] ?? unverified.length} approvals`} ` +
        `on file ${unverified.length === 1 ? "was" : "were"} recorded before this ledger kept what role the ` +
        `approver held, so ${unverified.length === 1 ? "it counts" : "they count"} towards the rules below ` +
        `without the role having been checked. A rule naming a role is not proven against ` +
        `${unverified.length === 1 ? "that signature" : "those signatures"} — it is waived for ` +
        `${unverified.length === 1 ? "it" : "them"}. Collecting the approval again would prove it.`,
    );
  }

  /*
   * A decision recorded against another entity's copy of this subject id.
   *
   * The unique index is (orgId, subjectType, subjectId, decidedBy) — org-wide —
   * so a subject id is a promise that it names one document in the whole
   * organisation, and the decisions are read back on that promise. A cuid keeps
   * it. A payroll period does not: "2026-03" is every entity's March, so a
   * director signing one company's payroll signs them all, and the posting path
   * cannot tell the difference.
   *
   * Reported rather than refused, and the choice is deliberate. Refusing would
   * mean the second company's payroll needs signatures the index physically
   * cannot accept from the same people, which is a month end that stops; saying
   * it out loud is what this ledger can honestly do until the subject id names
   * the entity. That belongs to whoever writes the id — see the note on the
   * PAYROLL register in `subjectFacts`.
   */
  const elsewhere = decisions.filter((d) => d.entityId !== input.entityId);
  if (elsewhere.length > 0) {
    const others = [...new Set(elsewhere.map((d) => d.entityId))].join(", ");
    caveats.push(
      `${elsewhere.length === 1 ? "One decision" : `${WORDS[elsewhere.length] ?? elsewhere.length} decisions`} on file ` +
        `${elsewhere.length === 1 ? "was" : "were"} recorded in ${others} rather than ${input.entityId}, against the same ` +
        `reference "${input.subjectId}". A reference has to name one document in the whole organisation for the decisions ` +
        `on it to be read back safely, and this one does not — so ${elsewhere.length === 1 ? "that signature is" : "those signatures are"} ` +
        `counted here having been given for another company's ${what}.`,
    );
  }

  for (const r of rules) {
    if (r.satisfied) continue;
    const scope = r.thresholdMinor === 0n
      ? `every ${what}`
      : `${what}s of ${aed(r.thresholdMinor, thresholdCurrency)} and above`;
    if (r.approverUserId) {
      blockers.push(
        `This ${what} of ${aed(amountMinor, currency)} needs the approval of ${r.approverUserId}, ` +
          `who the rule for ${scope} names; they have not approved it yet.`,
      );
    } else {
      const wrongRole = r.approverRole
        ? counting.filter((d) => d.decidedByRoles !== null && !holdsRole(d, r.approverRole as string))
        : [];
      blockers.push(
        `This ${what} of ${aed(amountMinor, currency)} needs ${approvals(r.missing)} from ` +
          `${roleAs(r.approverRole ?? "approver")} — the rule for ${scope} requires ` +
          `${WORDS[r.approversRequired] ?? r.approversRequired}.` +
          // Naming who signed but does not answer this rule is the difference
          // between "chase somebody" and "chase the right somebody".
          (wrongRole.length
            ? ` ${wrongRole.map((d) => d.decidedBy).join(", ")} ` +
              `${wrongRole.length === 1 ? "has" : "have"} approved it and ` +
              `${wrongRole.length === 1 ? "is" : "are"} not ${roleAs(r.approverRole as string)}, so ` +
              `${wrongRole.length === 1 ? "that signature does" : "those signatures do"} not answer this rule.`
            : ""),
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
    caveats,
    matchedOnMinor: matchMinor,
    thresholdCurrency,
  };
}


/* ------------------------------------------------------- thresholds and money */

/**
 * A threshold is written in one currency; a document arrives in another.
 *
 * "Bills over 50,000 need two directors" is a sentence about dirhams, because
 * that is what the business reports in. A EUR 20,000 bill is about AED 80,000
 * of real money, and comparing 20,000 to 50,000 let it through a rule written
 * to stop exactly that. Multi-currency posting is first-class in this ledger,
 * so this is not a corner case.
 *
 * Two figures come out of here and they are used for different things:
 *
 *   the FACE amount is what the approver was shown and what their decision was
 *   recorded against, so the staleness check has to keep using it — converting
 *   it would make every signature on a foreign document look as though it had
 *   been given for a different number, and nothing would ever post;
 *
 *   the MATCH amount is the same money in the book's currency, and it is the
 *   only figure a threshold may be compared against.
 *
 * Where no rate is on file, this does NOT quietly fall back to the face value.
 * It says so, and `computeState` turns that into a blocker — but only when it
 * could change the answer, which is when some rule's threshold sits above the
 * face amount. A rule at zero applies either way, and interrupting somebody for
 * a rate that cannot move the outcome is how a control teaches people to work
 * around it.
 */
async function convertForThresholds(opts: {
  orgId: string;
  entityId: string;
  amountMinor: bigint;
  currency?: string;
  rules: RuleRow[];
  asOf?: Date;
}): Promise<{
  matchMinor: bigint;
  thresholdCurrency: string;
  rateMissing: { currency: string; asOf: string } | null;
}> {
  const book = await prisma.book.findFirst({
    where: { orgId: opts.orgId, entityId: opts.entityId, code: "PRIMARY" },
    select: { functionalCurrency: true },
  });
  const functional = book?.functionalCurrency ?? "AED";
  const face = (opts.currency ?? functional).trim().toUpperCase();

  // The ordinary case, and the one that must cost nothing: the document is in
  // the currency the limits are written in.
  if (!face || face === functional) {
    return { matchMinor: opts.amountMinor, thresholdCurrency: functional, rateMissing: null };
  }

  const asOf = opts.asOf ?? new Date();
  const row = await prisma.fxRate.findFirst({
    where: { orgId: opts.orgId, entityId: opts.entityId, currency: face, rateDate: { lte: asOf } },
    orderBy: { rateDate: "desc" },
  });

  if (!row) {
    // Only material where a threshold sits above the face amount — below that,
    // every rule applies on either figure and the rate cannot change anything.
    const size = abs(opts.amountMinor);
    const couldMatter = opts.rules.some((r) => r.active && r.thresholdMinor > size);
    return {
      matchMinor: opts.amountMinor,
      thresholdCurrency: functional,
      rateMissing: couldMatter ? { currency: face, asOf: asOf.toISOString().slice(0, 10) } : null,
    };
  }

  // The rate is Decimal(20,10) so that 3.6725 is held exactly; it is scaled to
  // an integer rather than passed through Number for the same reason.
  const text = row.rate.toFixed();
  const m = /^\s*(\d+)(?:\.(\d*))?\s*$/.exec(text);
  if (!m) return { matchMinor: opts.amountMinor, thresholdCurrency: functional, rateMissing: null };
  const frac = (m[2] ?? "").padEnd(10, "0");
  let scaled = BigInt(m[1] + frac.slice(0, 9));
  if (Number(frac[9] ?? "0") >= 5) scaled += 1n;
  if (scaled === 0n) return { matchMinor: opts.amountMinor, thresholdCurrency: functional, rateMissing: null };

  // Minor units are not comparable across currencies without the exponent: 100
  // fils is 1 AED and 100 fils is a tenth of a dinar. Ignoring this is wrong by
  // a factor of ten in exactly the currencies a UAE business trades with.
  const shift = exponentOf(functional) - exponentOf(face);
  const numerator = abs(opts.amountMinor) * scaled * (shift > 0 ? 10n ** BigInt(shift) : 1n);
  const denominator = 1_000_000_000n * (shift < 0 ? 10n ** BigInt(-shift) : 1n);
  // Half away from zero, the same rounding the rest of the ledger uses.
  const converted = (numerator * 2n + denominator) / (denominator * 2n);

  return {
    matchMinor: opts.amountMinor < 0n ? -converted : converted,
    thresholdCurrency: functional,
    rateMissing: null,
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

  const rules = ruleRows.map(asRule);
  const converted = await convertForThresholds({
    orgId: opts.orgId,
    entityId: opts.entityId,
    amountMinor,
    currency: opts.currency,
    rules,
  });

  return computeState({
    entityId: opts.entityId,
    subjectType,
    subjectId,
    amountMinor,
    currency: opts.currency,
    matchMinor: converted.matchMinor,
    thresholdCurrency: converted.thresholdCurrency,
    rateMissing: converted.rateMissing,
    // Matched on the converted figure; the decisions are still compared against
    // the face amount, which is what the approver was shown.
    rules: applicable(rules, converted.matchMinor),
    decisions: decisionRows.map(asDecision),
  });
}

/* ----------------------------------------------------------------- registers */

/**
 * Where each of the five subjects actually lives, and what it is worth.
 *
 * This module used to know about one of them. An expense claim has a table of
 * its own, so a claim could be found, priced and attributed to whoever raised
 * it; the other four were whatever the caller said they were. Two things went
 * wrong because of that, and both are the same mistake.
 *
 * The queue seeded itself from submitted claims plus subjects somebody had
 * already decided on, so a bill could enter the queue only if it was already in
 * it. An organisation that wrote the rule the approvals screen invites — "every
 * supplier bill needs one signature" — could then never post a bill again:
 * nothing put the bill in front of an approver, and the guard refused it at the
 * posting path for want of the signature nobody had been asked for. While the
 * guard was called from nowhere that rule was decoration; the day it was wired
 * into the posting paths it stopped the month end instead.
 *
 * And the self-approval bar was armed only when a caller handed this module the
 * raiser, which only the claim table could do — so the person who prepared a
 * payment run could approve it here, in the file written to stop exactly that.
 *
 * So: one place that answers, for any of the five, which entity the subject is
 * in, what it is worth, what to call it and who raised it. Where the ledger
 * genuinely does not record something the answer is null, and the caller says
 * what it does about that rather than this file guessing.
 */

/** Inbound documents live in the same record store the invoice editor writes. */
const BILL_STORE = "invoices";

/**
 * How many unfinished documents of one kind the queue will look at.
 *
 * A bound rather than a page, because this is a work queue and not a report: a
 * business with more than five hundred unposted bills in one entity has a
 * bigger problem than the order they are shown in. The bound is applied newest
 * first for the reason given on `pendingFor` — work that has just arrived has
 * to be able to get in.
 */
const REGISTER_LIMIT = 500;

/** A subject the queue considers, before the rules are applied to it. */
interface Candidate {
  entityId: string;
  subjectType: SubjectType;
  subjectId: string;
  label: string;
  amountMinor: bigint;
  /** The document's own currency, so the queue quotes euros as euros. */
  currency: string;
  waitingSince: Date;
  submittedBy: string | null;
}

/** What the register knows about one subject, for a caller holding only its id. */
export interface SubjectFacts {
  /** The entity the SUBJECT is in — never the one the request asked about. */
  entityId: string;
  label: string;
  /** Null where the register holds no figure for it, as for a manual journal. */
  amountMinor: bigint | null;
  currency: string | null;
  /** Who raised it, where this ledger records that at all. */
  submittedBy: string | null;
  waitingSince: Date | null;
}

/** A bill as the invoice store holds it, read narrowly — the related-party scan reads it the same way. */
type BillDoc = {
  entityId?: string;
  direction?: string;
  docType?: string;
  number?: string;
  currency?: string;
  lifecycleStatus?: string;
  seller?: { nameEn?: string };
  totals?: { payableMinor?: number | string };
};

/** A figure out of a stored JSON document, or null where it is not one. */
function docMinor(v: number | string | undefined | null): bigint | null {
  if (typeof v === "number") return Number.isInteger(v) ? BigInt(v) : null;
  if (typeof v === "string" && /^-?\d+$/.test(v.trim())) return BigInt(v.trim());
  return null;
}

function billCandidate(row: { id: string; entityId: string | null; createdAt: Date; data: string }): Candidate | null {
  let doc: BillDoc | null = null;
  try { doc = JSON.parse(row.data) as BillDoc; } catch { return null; }
  // Only the buyer side. A sales invoice is not something a supplier-bill rule
  // was written about, and cancelled documents are nobody's work.
  if (!doc || doc.direction !== "INBOUND" || doc.lifecycleStatus === "CANCELLED") return null;
  const entityId = row.entityId ?? doc.entityId ?? "";
  const payable = docMinor(doc.totals?.payableMinor);
  // A document whose total cannot be read cannot be measured against a
  // threshold, so it is left out of the queue rather than shown at zero. It is
  // still refused at the posting path, where postBill computes the figure from
  // the lines rather than from this, so nothing escapes by being unreadable.
  if (!entityId || payable === null) return null;
  // Signed the way postBill signs it. A credit note is money the other way, and
  // an approval recorded against the positive figure would be an approval of a
  // document that does not exist.
  const sign = doc.docType === "TAX_CREDIT_NOTE" ? -1n : 1n;
  return {
    entityId,
    subjectType: "BILL",
    subjectId: row.id,
    label: `${doc.number ?? row.id} — ${doc.seller?.nameEn ?? "supplier"}`,
    amountMinor: payable * sign,
    currency: (doc.currency ?? "").trim().toUpperCase() || "AED",
    waitingSince: row.createdAt,
    // Nothing on an inbound document records who keyed or received it, so the
    // self-approval bar cannot bind on a bill. Said out loud rather than left
    // to be discovered: it needs a column on the record, not a guess here.
    submittedBy: null,
  };
}

/** The gross cost of employing people for a month — what a payroll rule is written against. */
const payrollGross = (s: {
  basicMinor: bigint | null; allowancesMinor: bigint | null; overtimeMinor: bigint | null;
  gratuityMinor: bigint | null; pensionEmployerMinor: bigint | null;
}) =>
  (s.basicMinor ?? 0n) + (s.allowancesMinor ?? 0n) + (s.overtimeMinor ?? 0n) +
  (s.gratuityMinor ?? 0n) + (s.pensionEmployerMinor ?? 0n);

const PAYROLL_SUM = {
  basicMinor: true, allowancesMinor: true, overtimeMinor: true,
  gratuityMinor: true, pensionEmployerMinor: true,
} as const;

/**
 * Everything a rule could apply to that has not finished yet.
 *
 * "Not finished" is read from each register in its own words: a claim that has
 * been submitted, a bill with no journal entry behind it, a payment run that
 * has not been released or cancelled, a month with draft payslips in it. That
 * is the state a document is in while it is waiting for a signature, which is
 * precisely the set the queue has to show.
 *
 * A manual journal has no register and cannot have one — it does not exist
 * until it posts — so it is absent here and reaches the queue through the
 * decisions recorded against the reference the poster chose. See `pendingFor`.
 */
async function openSubjects(opts: {
  orgId: string;
  entityId?: string;
  subjectType?: SubjectType;
}): Promise<Candidate[]> {
  const wants = (t: SubjectType) => !opts.subjectType || opts.subjectType === t;
  const entity = opts.entityId ? { entityId: opts.entityId } : {};

  const [claims, billRows, runs, periods] = await Promise.all([
    wants("EXPENSE_CLAIM")
      ? prisma.expenseClaim.findMany({
          where: { orgId: opts.orgId, status: "submitted", ...entity },
          include: { lines: { select: { netMinor: true, vatMinor: true, vatRecoverable: true } } },
          orderBy: [{ submittedAt: "desc" }],
          take: REGISTER_LIMIT,
        })
      : Promise.resolve([]),
    wants("BILL")
      ? prisma.record.findMany({
          where: {
            orgId: opts.orgId,
            store: BILL_STORE,
            ...entity,
            // The buyer side only. Direction lives inside the stored document
            // rather than in a column, so this narrows the READ — every record
            // is written by JSON.stringify, which spaces nothing — and
            // `billCandidate` still parses the document and decides properly.
            // Without it the newest five hundred records in a business that
            // sends more than it receives would be all sales invoices, and the
            // bills waiting for a signature would never be looked at.
            data: { contains: '"direction":"INBOUND"' },
          },
          select: { id: true, entityId: true, createdAt: true, data: true },
          orderBy: [{ createdAt: "desc" }],
          take: REGISTER_LIMIT,
        })
      : Promise.resolve([]),
    wants("PAYMENT")
      ? prisma.paymentRun.findMany({
          where: { orgId: opts.orgId, status: { in: ["draft", "approved"] }, ...entity },
          include: { items: { where: { excluded: false }, select: { amountMinor: true } } },
          orderBy: [{ createdAt: "desc" }],
          take: REGISTER_LIMIT,
        })
      : Promise.resolve([]),
    wants("PAYROLL")
      ? prisma.payslip.groupBy({
          by: ["entityId", "period"],
          where: { orgId: opts.orgId, status: "draft", ...entity },
          _sum: PAYROLL_SUM,
          _min: { createdAt: true },
          _count: { _all: true },
          orderBy: [{ period: "desc" }],
          take: 100,
        })
      : Promise.resolve([]),
  ]);

  const out: Candidate[] = [];

  for (const c of claims) {
    out.push({
      entityId: c.entityId,
      subjectType: "EXPENSE_CLAIM",
      subjectId: c.id,
      label: `${c.reference} — ${c.employeeName}`,
      amountMinor: totalsOf(c.lines).totalMinor,
      currency: c.currency,
      waitingSince: c.submittedAt ?? c.createdAt,
      // The claimant, in the claim's own namespace. Same caveat as expenses.ts:
      // it only bars self-approval where employee codes and user ids are the
      // same thing in this deployment.
      submittedBy: c.employeeCode,
    });
  }

  // A bill that has already posted is nobody's work — and a rule written after
  // it posted must not reach back and put it in somebody's queue. postBill
  // writes one entry per bill under this key, so the entry is the evidence.
  //
  // Deliberately no status filter, and not an oversight: this is exactly the
  // query postBill's own idempotency check makes. Where that would hand back
  // the existing entry rather than posting again, there is nothing here for
  // anybody to approve, whatever state the entry is in.
  const bills = billRows.map(billCandidate).filter((b): b is Candidate => b !== null);
  if (bills.length > 0) {
    const posted = await prisma.journalEntry.findMany({
      where: { orgId: opts.orgId, externalKey: { in: bills.map((b) => `bill:${b.subjectId}`) } },
      select: { externalKey: true },
    });
    const done = new Set(posted.map((p) => p.externalKey));
    for (const b of bills) if (!done.has(`bill:${b.subjectId}`)) out.push(b);
  }

  for (const r of runs) {
    out.push({
      entityId: r.entityId,
      subjectType: "PAYMENT",
      subjectId: r.id,
      label: `${r.reference} — ${r.items.length} bill${r.items.length === 1 ? "" : "s"}`,
      // What the run will actually pay: the bills still in it, excluding the
      // ones somebody took out. It is the same total releaseRun() posts.
      amountMinor: r.items.reduce((a, i) => a + i.amountMinor, 0n),
      currency: r.currency,
      waitingSince: r.createdAt,
      // The row's own record of who proposed it, which is the fact the run's
      // separate control is built on and the reason it is trustworthy here.
      submittedBy: r.preparedBy,
    });
  }

  if (periods.length > 0) {
    // Payroll is posted in the book's own currency, and the register holds no
    // currency of its own to read it off.
    const books = await prisma.book.findMany({
      where: { orgId: opts.orgId, code: "PRIMARY", entityId: { in: [...new Set(periods.map((p) => p.entityId))] } },
      select: { entityId: true, functionalCurrency: true },
    });
    const currencyOf = new Map(books.map((b) => [b.entityId, b.functionalCurrency]));
    for (const p of periods) {
      out.push({
        entityId: p.entityId,
        subjectType: "PAYROLL",
        subjectId: p.period,
        label: `${p.period} — ${p._count._all} payslip${p._count._all === 1 ? "" : "s"}`,
        amountMinor: payrollGross(p._sum),
        currency: currencyOf.get(p.entityId) ?? "AED",
        waitingSince: p._min.createdAt ?? new Date(),
        // Nobody is recorded as having prepared a month's payroll. Same gap as
        // a bill, and the same fix — a column, not a guess.
        submittedBy: null,
      });
    }
  }

  return out;
}

/**
 * Which entity a subject is in, what it is worth, and who raised it.
 *
 * Read from the SUBJECT, never from the request. A caller who could name the
 * entity could name one they hold a role on and then decide on a document
 * belonging to another — which is the hole this closes, and the same reason the
 * bill route reads the entity off the bill and the claim route off the claim.
 *
 * Where no register answers, the decisions already on file do: the first
 * decision pins a subject to the entity its round was opened in, so a manual
 * journal's reference cannot be adopted by a second entity halfway through.
 * Null means neither could answer — a subject nobody has touched that no
 * register holds — and there is then nothing to hijack.
 *
 * PAYROLL is the one subject whose id does not name a document. `postPayroll`
 * uses the period, so "2026-03" is every entity's March; where several entities
 * ran that month this can only narrow it with the entity the caller asked
 * about, and `computeState` reports the residue as a caveat.
 */
export async function subjectFacts(opts: {
  orgId: string;
  subjectType: SubjectType | string;
  subjectId: string;
  /** Only used where the subject's own id cannot name one entity — see PAYROLL. */
  entityId?: string;
}): Promise<SubjectFacts | null> {
  const subjectType = assertSubjectType(opts.subjectType);
  const subjectId = (opts.subjectId ?? "").trim();
  if (!subjectId) return null;

  if (subjectType === "EXPENSE_CLAIM") {
    const claim = await prisma.expenseClaim.findFirst({
      where: { id: subjectId, orgId: opts.orgId },
      include: { lines: { select: { netMinor: true, vatMinor: true, vatRecoverable: true } } },
    });
    if (claim) {
      return {
        entityId: claim.entityId,
        label: `${claim.reference} — ${claim.employeeName}`,
        amountMinor: totalsOf(claim.lines).totalMinor,
        currency: claim.currency,
        submittedBy: claim.employeeCode,
        waitingSince: claim.submittedAt ?? claim.createdAt,
      };
    }
  }

  if (subjectType === "BILL") {
    const row = await prisma.record.findUnique({
      where: { store_id: { store: BILL_STORE, id: subjectId } },
      select: { id: true, orgId: true, entityId: true, createdAt: true, data: true },
    });
    const c = row && row.orgId === opts.orgId ? billCandidate(row) : null;
    if (c) {
      return {
        entityId: c.entityId,
        label: c.label,
        amountMinor: c.amountMinor,
        currency: c.currency,
        submittedBy: c.submittedBy,
        waitingSince: c.waitingSince,
      };
    }
  }

  if (subjectType === "PAYMENT") {
    // A payment run. A single supplier payment is identified by whatever
    // reference the payment carried and has no row of its own, so it falls
    // through to the decisions below.
    const run = await prisma.paymentRun.findFirst({
      where: { id: subjectId, orgId: opts.orgId },
      include: { items: { where: { excluded: false }, select: { amountMinor: true } } },
    });
    if (run) {
      return {
        entityId: run.entityId,
        label: `${run.reference} — ${run.items.length} bill${run.items.length === 1 ? "" : "s"}`,
        amountMinor: run.items.reduce((a, i) => a + i.amountMinor, 0n),
        currency: run.currency,
        submittedBy: run.preparedBy,
        waitingSince: run.createdAt,
      };
    }
  }

  if (subjectType === "PAYROLL") {
    const groups = await prisma.payslip.groupBy({
      by: ["entityId"],
      where: { orgId: opts.orgId, period: subjectId, status: "draft" },
      _sum: PAYROLL_SUM,
      _min: { createdAt: true },
      _count: { _all: true },
    });
    // One entity ran that month: the id names it after all. Several did, and
    // the best this can do is the entity the caller was asking about — which is
    // no worse than before and is reported where it matters.
    const g = groups.length === 1 ? groups[0] : groups.find((r) => r.entityId === opts.entityId);
    if (g) {
      const book = await prisma.book.findFirst({
        where: { orgId: opts.orgId, entityId: g.entityId, code: "PRIMARY" },
        select: { functionalCurrency: true },
      });
      return {
        entityId: g.entityId,
        label: `${subjectId} — ${g._count._all} payslip${g._count._all === 1 ? "" : "s"}`,
        amountMinor: payrollGross(g._sum),
        currency: book?.functionalCurrency ?? "AED",
        submittedBy: null,
        waitingSince: g._min.createdAt,
      };
    }
  }

  // No register — a manual journal's reference, a single supplier payment, or a
  // document that has since been posted or thrown away. The round that was
  // opened against it says where it belongs.
  const rows = await prisma.approvalDecision.findMany({
    where: { orgId: opts.orgId, subjectType, subjectId },
    orderBy: [{ decidedAt: "asc" }],
  });
  if (rows.length === 0) return null;
  const priced = [...rows].reverse().find((r) => r.amountMinor !== null);
  return {
    entityId: rows[0].entityId,
    label: subjectId,
    amountMinor: priced?.amountMinor ?? null,
    currency: null,
    submittedBy: null,
    waitingSince: rows[0].decidedAt,
  };
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
/**
 * The role codes a person holds right now, for recording on a decision.
 *
 * Distinct from `permissionsOf`, which answers "may they" — this answers "what
 * are they", which is what a rule naming a role asks. An unconfigured workspace
 * returns nothing, and that is correct: nobody is a director until somebody
 * says so, and a role rule written in a workspace with no roles is a rule about
 * a thing that does not exist yet.
 */
async function rolesHeldBy(opts: {
  orgId: string;
  entityId: string;
  userId: string;
}): Promise<string[] | null> {
  // Null, not empty, in a workspace that has configured no roles at all.
  //
  // The difference is the whole escape hatch this product rests on: with no
  // roles configured every member may do everything, and "what role did they
  // hold" has no answer rather than the answer "none". Recording an empty list
  // would make a rule naming a director unsatisfiable in exactly the workspaces
  // that have not set up roles — so writing a rule would lock the document, and
  // the only way out would be to install the role system the business had
  // decided not to use.
  const anyAssignment = await prisma.roleAssignment.findFirst({
    where: { orgId: opts.orgId },
    select: { id: true },
  });
  if (!anyAssignment) return null;

  const rows = await prisma.roleAssignment.findMany({
    where: {
      orgId: opts.orgId,
      userId: opts.userId,
      entityId: { in: [opts.entityId, "*"] },
    },
    include: { role: { select: { code: true, status: true } } },
  });
  const out = new Set<string>();
  for (const r of rows) if (r.role.status === "active") out.add(r.role.code);
  return [...out].sort();
}

export async function decide(opts: {
  orgId: string;
  entityId: string;
  subjectType: SubjectType | string;
  subjectId: string;
  decision: DecisionKind | string;
  decidedBy: string;
  amountMinor: number | bigint | string;
  reason?: string | null;
  /**
   * Who raised the thing. Optional because it is no longer trusted to arrive:
   * where it is absent the register is asked. Pass it where the caller has
   * already read the document and would only be paying for the lookup twice.
   */
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

  // Who raised it, asked for rather than waited for.
  //
  // The bar below only ever armed when a caller passed `submittedBy`, and the
  // only caller that could was the approvals route deciding on an expense
  // claim — the one subject this module could look up. So on the other four it
  // protected nothing: whoever proposed a payment run could approve it here,
  // in the file whose header calls that the one thing that is not negotiable.
  // Reading the register ourselves means the bar binds wherever the ledger
  // records a raiser at all, whatever the caller remembered to pass.
  const submittedBy =
    (opts.submittedBy ?? "").trim() ||
    (await subjectFacts({ orgId: opts.orgId, subjectType, subjectId, entityId: opts.entityId }))?.submittedBy?.trim() ||
    null;

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
        // What this person was when they decided, so a rule naming a role has
        // something to check against — and so it still checks against the same
        // thing in a year, when they may hold a different role or none. Empty
        // where they held none, which is an answer; null where the workspace
        // has no roles at all, where the question has none.
        decidedByRoles: (
          await rolesHeldBy({ orgId: opts.orgId, entityId: opts.entityId, userId: decidedBy })
        )?.join(",") ?? null,
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
 *   - postPayroll() in payroll.ts, before it posts the month — wired, against
 *     the period as the subject and the gross cost of employment as the
 *     amount;
 *   - releaseRun() in payment-runs.ts, which posts a batch of supplier
 *     payments — wired; see the note in that file for why the run also keeps
 *     a control of its own, and why the two are different questions.
 *
 * That is every posting path in the product. A rule an organisation writes on
 * the approvals screen now binds on all of them.
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
  /** The document's own currency, which is not always the book's. */
  currency: string;
  /** Waiting for signatures, or refused and going nowhere until it is withdrawn. */
  state: SubjectState;
  approvalsOutstanding: number;
  blockers: string[];
  /** True of it and not a reason it cannot proceed — see `ApprovalState`. */
  caveats: string[];
  /** Since when it has been sitting there, so the queue can be worked oldest first. */
  waitingSince: Date;
}

/**
 * How far back the queue looks for a subject that has no register.
 *
 * Newest first, and that direction is the whole point. This read used to be
 * `take: 5000` ordered oldest-first with no filter on whether the subject was
 * finished, and for every subject but an expense claim the candidate set was
 * derived entirely from it — so at five thousand LIFETIME decisions the oldest
 * five thousand were kept and nothing recorded afterwards could enter the queue
 * again. Two approvers at a hundred documents a month reach that in about two
 * years, and the control then stops working without saying anything. Ordering
 * the other way means what is falling off the end is the oldest history rather
 * than today's work.
 */
const RECENT_DECISIONS = 2000;

/**
 * What is waiting on this person.
 *
 * A queue, not a search box: an approver should open the screen and see the
 * work, not have to know the reference of a bill somebody else keyed. So the
 * candidates are the OPEN SUBJECTS — every claim, bill, payment run and payroll
 * month a rule could apply to, read from the registers in `openSubjects` — plus
 * anything somebody has already decided on that those registers do not hold.
 *
 * That second half is not a fallback, it is the manual journal: an entry does
 * not exist until it posts, so the only trace of one waiting for signatures is
 * the decisions recorded against the reference its poster chose. It also
 * catches a single supplier payment, which is identified by its own reference
 * and has no row anywhere.
 *
 * It used to be the whole of it, and that was the defect. A subject could enter
 * the queue only once somebody had decided on it, and the only screen that
 * records a decision is this queue — so a bill entered the queue only if it was
 * already in it. Writing the rule the screen invites ("every supplier bill
 * needs one signature") made bills permanently unpostable, because the guard on
 * the posting path asked for a signature the queue never asked anybody to give.
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

  const [ruleRows, open] = await Promise.all([
    prisma.approvalRule.findMany({
      where: { orgId: opts.orgId, active: true, ...(opts.entityId ? { entityId: opts.entityId } : {}), ...(subjectType ? { subjectType } : {}) },
    }),
    openSubjects({ orgId: opts.orgId, entityId: opts.entityId, subjectType }),
  ]);

  const rules = ruleRows.map(asRule);

  const candidates = new Map<string, Candidate>();
  for (const c of open) candidates.set(`${c.subjectType}:${c.subjectId}`, c);

  const [onOpen, recentRows] = await Promise.all([
    // Every decision on the subjects the registers just found — read by id
    // rather than by taking a slice of the table, so no amount of history can
    // push a document that is open today out of its own queue.
    //
    // Deliberately not narrowed to the entity: the unique index is org-wide, so
    // that is how `approvalState` reads them at posting time, and a queue that
    // counted a subset of the decisions the guard counts would tell people
    // something different from what the ledger will do.
    candidates.size === 0
      ? Promise.resolve([])
      : prisma.approvalDecision.findMany({
          where: { orgId: opts.orgId, subjectId: { in: [...candidates.values()].map((c) => c.subjectId) } },
        }),
    prisma.approvalDecision.findMany({
      where: { orgId: opts.orgId, ...(opts.entityId ? { entityId: opts.entityId } : {}), ...(subjectType ? { subjectType } : {}) },
      orderBy: [{ decidedAt: "desc" }],
      take: RECENT_DECISIONS,
    }),
  ]);

  // Both reads overlap wherever an open subject has been decided on recently,
  // so they are merged by row id rather than concatenated — a decision counted
  // twice would satisfy a rule asking for two approvers on its own.
  const decisions = new Map<string, DecisionRow>();
  for (const d of [...onOpen, ...recentRows]) decisions.set(d.id, asDecision(d));

  const bySubject = new Map<string, DecisionRow[]>();
  for (const d of decisions.values()) {
    const k = `${d.subjectType}:${d.subjectId}`;
    const list = bySubject.get(k);
    if (list) list.push(d);
    else bySubject.set(k, [d]);
  }

  // The subjects no register holds — a manual journal's reference, a single
  // supplier payment. Only from the filtered read: a row picked up by subject
  // id alone could belong to another entity or another kind of document.
  const fromDecisions: Candidate[] = [];
  for (const row of recentRows) {
    const d = decisions.get(row.id) as DecisionRow;
    const k = `${d.subjectType}:${d.subjectId}`;
    if (candidates.has(k)) continue;
    const rows = bySubject.get(k) ?? [d];
    // The amount as last decided on. A decision carries the figure it was shown,
    // which is the only amount this module knows for a subject with no table here.
    const withAmount = [...rows].reverse().find((r) => r.amountMinor !== null);
    if (!withAmount) continue;
    const first = rows.reduce((a, b) => (a.decidedAt <= b.decidedAt ? a : b));
    const c: Candidate = {
      entityId: first.entityId,
      subjectType: first.subjectType,
      subjectId: first.subjectId,
      label: first.subjectId,
      amountMinor: withAmount.amountMinor as bigint,
      // Both kinds of subject that get here — a manual journal and a single
      // supplier payment — are measured by their posting paths in the book's
      // own currency, so that is what the figure is in. Filled in below.
      currency: "",
      waitingSince: first.decidedAt,
      submittedBy: null,
    };
    candidates.set(k, c);
    fromDecisions.push(c);
  }
  if (fromDecisions.length > 0) {
    const books = await prisma.book.findMany({
      where: { orgId: opts.orgId, code: "PRIMARY", entityId: { in: [...new Set(fromDecisions.map((c) => c.entityId))] } },
      select: { entityId: true, functionalCurrency: true },
    });
    const currencyOf = new Map(books.map((b) => [b.entityId, b.functionalCurrency]));
    for (const c of fromDecisions) c.currency = currencyOf.get(c.entityId) ?? "AED";
  }

  const out: PendingItem[] = [];
  for (const c of candidates.values()) {
    if (subjectType && c.subjectType !== subjectType) continue;
    if (opts.entityId && c.entityId !== opts.entityId) continue;

    // No currency conversion here, deliberately. The queue settles every open
    // subject from a handful of queries and converting each would mean a rate
    // lookup per row; more to the point, this list decides what to SHOW,
    // while `approvalState` decides what may post — and that one converts. A
    // foreign document can therefore appear in the queue against the wrong
    // band, and it still cannot post until the rate is on file and the rules
    // are met on the converted figure.
    const state = computeState({
      entityId: c.entityId,
      subjectType: c.subjectType,
      subjectId: c.subjectId,
      amountMinor: c.amountMinor,
      currency: c.currency,
      rules: applicable(rules.filter((r) => r.entityId === c.entityId && r.subjectType === c.subjectType), c.amountMinor),
      decisions: bySubject.get(`${c.subjectType}:${c.subjectId}`) ?? [],
    });

    // Nothing to do: it has every signature its rules ask for, or it meets no
    // rule at all and never needed one.
    if (state.approved) continue;

    const decided = state.decisions.some((d) => samePerson(d.decidedBy, userId));
    // A rule names them, whether or not that rule is still outstanding. Used
    // for a refusal, where the question is who may deal with it rather than who
    // still owes a signature.
    const names = (r: AppliedRule) =>
      r.approverUserId ? samePerson(r.approverUserId, userId) : role !== null && samePerson(r.approverRole ?? "", role);

    if (state.rejected) {
      /*
       * A refused document, shown so that somebody can withdraw it.
       *
       * `withdraw` was routed, four separate messages told people to use it —
       * the blocker every posting path returns among them — and no screen sent
       * it, because the queue hid the one kind of subject it applies to. A
       * rejection stands until the round is withdrawn, so hiding them meant a
       * refused bill was refused for ever and the only way past it was a
       * database.
       *
       * Shown to whoever the rules name AND to whoever has already decided:
       * the person who refused it is the likeliest to withdraw it once it has
       * been fixed, and they are the one person the pending branch below
       * deliberately filters out.
       */
      if (!state.rules.some(names) && !decided) continue;
    } else {
      // Already had their say — the unique index would refuse a second one anyway.
      if (decided) continue;
      // Their own document is not waiting on them; nobody approves their own work.
      if (c.submittedBy && samePerson(c.submittedBy, userId)) continue;
      if (!state.rules.some((r) => !r.satisfied && names(r))) continue;
    }

    out.push({
      entityId: c.entityId,
      subjectType: c.subjectType,
      subjectId: c.subjectId,
      label: c.label,
      amountMinor: c.amountMinor,
      currency: c.currency,
      state: state.state,
      approvalsOutstanding: state.approvalsOutstanding,
      blockers: state.blockers,
      caveats: state.caveats,
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
