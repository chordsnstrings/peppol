import { requireSession } from "@/lib/server/session";
import { requirePermission, PermissionError } from "@/lib/server/ledger/permissions";
import { assertSameOrigin } from "@/lib/server/platform-admin";
import { json, handleError } from "@/lib/server/http";
import { prisma } from "@/lib/server/prisma";
import { ledgerJson } from "@/lib/server/ledger/serialize";
import { LedgerError } from "@/lib/server/ledger/post";
import {
  setRule, listRules, deactivateRule,
  approvalState, decide, withdraw, pendingFor, subjectFacts,
  type SubjectType, type DecisionKind,
} from "@/lib/server/ledger/approvals";

export const runtime = "nodejs";

/**
 * Which permission a decision on this kind of document takes.
 *
 * An approver is not an administrator. Recording a decision is an act on one
 * document, so it must not need `roles.manage` — the shipped APPROVER role
 * holds no administration at all and is exactly who this route exists for.
 * Writing the RULE is the administrative act, and it is guarded as one below.
 *
 * A payment takes `payment_run.approve` — "sign off a batch so it can be
 * released" — and that matters beyond fitting the sentence: propose-and-approve
 * is one of the conflicts this product reports on, and it can only report
 * somebody signing off payments if signing off payments is the permission they
 * hold.
 *
 * The other four take `approval.decide`, which is now in the catalogue and says
 * exactly this: record a decision on a journal, a bill, a claim or a payroll
 * run somebody else prepared. They used to take `expense.approve`, which was
 * the closest key that existed and was wider here than its own effect sentence
 * — it names a colleague's claim for reimbursement, and it was being used to
 * sign off a payroll run. The shipped APPROVER holds both keys and OWNER holds
 * everything, so no shipped role can do less than it did; a workspace's own
 * role that holds `expense.approve` and not `approval.decide` is listed on the
 * roles screen, act by act, under what it stands to lose.
 */
function decisionPermission(subjectType: SubjectType): string {
  return subjectType === "PAYMENT" ? "payment_run.approve" : "approval.decide";
}

/** The rules in force and this person's queue, or the state of one subject. */
export async function GET(req: Request) {
  try {
    const { orgId, userId } = await requireSession();
    const q = new URL(req.url).searchParams;

    const entityId = q.get("entityId");
    if (!entityId) return json({ error: "entityId required" }, 400);

    const subjectId = q.get("subjectId");
    const subjectType = q.get("subjectType") as SubjectType | null;
    // Read before the guard, not after it, so the check below can be made
    // against the entity the document actually belongs to rather than the one
    // the query string claimed — the same preference `decide` makes, for the
    // same reason.
    const facts = subjectId && subjectType
      ? await subjectFacts({ orgId, subjectType, subjectId, entityId })
      : null;

    /* Reading the rules in force, and your own queue — `ledger.read`.
     *
     * Deliberately not `roles.manage`. An approver has to be able to see what
     * the business asks of them and what is waiting on them, and a control
     * that only administrators may read is a control people work around
     * because nobody can tell them why they are stuck. The queue is scoped to
     * the caller inside `pendingFor`, so this shows nobody anybody else's
     * work; the rules are the same rules the blockers quote back on screen.
     *
     * Scoped to the entity, because the rules in force and what is waiting on
     * this entity are not what a grant on a sister company was given for. */
    await requirePermission({ orgId, userId, entityId: facts?.entityId ?? entityId, permission: "ledger.read" });

    if (subjectId && subjectType) {
      return json(ledgerJson({
        state: await approvalState({
          orgId,
          entityId: facts?.entityId ?? entityId,
          subjectType,
          subjectId,
          amountMinor: facts?.amountMinor ?? (q.get("amountMinor") ?? "0"),
          // The document's own currency where the register keeps one, so the
          // blockers quote euros as euros and the thresholds in the book's own
          // unit rather than silently calling them the same thing.
          currency: facts?.currency ?? undefined,
        }),
      }));
    }

    // One request, because the screen is useless without both halves: the rules
    // say what the business asks for, the queue says what it is waiting on.
    const [rules, pending] = await Promise.all([
      listRules({ orgId, entityId, includeInactive: q.get("includeInactive") === "1" }),
      pendingFor({ orgId, userId, entityId }),
    ]);
    return json(ledgerJson({ rules, pending }));
  } catch (e) {
    if (e instanceof PermissionError) return json({ error: e.message }, 403);
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}

/** Write a rule, switch one off, decide on a subject, or withdraw a round. */
export async function POST(req: Request) {
  try {
    await assertSameOrigin(req);
    const { orgId, userId } = await requireSession();
    const b = (await req.json().catch(() => ({}))) as {
      action?: "setRule" | "deactivateRule" | "decide" | "withdraw";
      entityId?: string;
      ruleId?: string;
      subjectType?: SubjectType;
      subjectId?: string;
      thresholdMinor?: string | number;
      approversRequired?: number;
      approverRole?: string | null;
      approverUserId?: string | null;
      decision?: DecisionKind;
      amountMinor?: string | number;
      reason?: string;
    };

    switch (b.action) {
      case "setRule": {
        if (!b.entityId || !b.subjectType) return json({ error: "Which entity, and what kind of document?" }, 400);
        /* Writing an approval rule is deciding who may approve what and above
         * what amount — "decide who may do everything above, including this",
         * which is `roles.manage`. It is a different power from approving: an
         * approver signs one document, whereas whoever writes the rule decides
         * how many signatures a million dirhams needs, and whose. */
        await requirePermission({ orgId, userId, entityId: b.entityId, permission: "roles.manage" });
        const rule = await setRule({
          orgId,
          entityId: b.entityId,
          subjectType: b.subjectType,
          thresholdMinor: b.thresholdMinor ?? 0,
          approversRequired: b.approversRequired ?? 1,
          approverRole: b.approverRole ?? null,
          approverUserId: b.approverUserId ?? null,
        });
        return json(ledgerJson({ rule }));
      }

      case "deactivateRule": {
        if (!b.ruleId) return json({ error: "Which rule?" }, 400);
        /* Switching a rule off is the same power as writing one, in the more
         * dangerous direction: a control that can be turned off by the people
         * it constrains is not a control.
         *
         * The request carries no entity, so the rule is read for one — every
         * approval rule belongs to exactly one entity, and turning off the
         * control over one company's payments is not something a grant on
         * another company should buy. A rule id that resolves to nothing has
         * no entity, and `deactivateRule` below is left to say so, so the
         * message for a rule that is not there is the one it always was. */
        const rule = await prisma.approvalRule.findFirst({
          where: { id: b.ruleId, orgId },
          select: { entityId: true },
        });
        await requirePermission({ orgId, userId, entityId: rule?.entityId, permission: "roles.manage" });
        return json(ledgerJson({ rule: await deactivateRule({ orgId, ruleId: b.ruleId }) }));
      }

      case "decide": {
        if (!b.entityId || !b.subjectType || !b.subjectId) {
          return json({ error: "Which entity, what kind of document, and which one?" }, 400);
        }
        if (b.decision !== "APPROVED" && b.decision !== "REJECTED") {
          return json({ error: "A decision is APPROVED or REJECTED." }, 400);
        }
        if (b.decision === "REJECTED" && !b.reason?.trim()) {
          return json({ error: "A rejection has to say why, so whoever raised it knows what to fix." }, 400);
        }
        const facts = await subjectFacts({ orgId, subjectType: b.subjectType, subjectId: b.subjectId, entityId: b.entityId });
        /* Deciding, which is not administering — see `decisionPermission`.
         *
         * Checked against the entity the document actually belongs to and not
         * the one the request named: a client that could choose the entity
         * could name one it holds a role on and then decide on a document
         * belonging to another. That used to be true of everything but an
         * expense claim, because a claim was the only subject this route could
         * look up — so somebody who could approve claims in one company could
         * approve, and un-approve, that company's sister's payroll run.
         * `subjectFacts` now answers for all five, from the register the
         * subject lives in or, where there is none, from the entity the round
         * of decisions was opened in. */
        await requirePermission({ orgId, userId, entityId: facts?.entityId ?? b.entityId, permission: decisionPermission(b.subjectType) });
        // The approver is whoever is signed in — never a value the request
        // supplies. Letting the client name the approver would hand away the
        // one control this whole file exists to hold.
        const r = await decide({
          orgId,
          entityId: facts?.entityId ?? b.entityId,
          subjectType: b.subjectType,
          subjectId: b.subjectId,
          decision: b.decision,
          decidedBy: userId,
          // The amount from the register, where the register has one: a client
          // that could name the amount could pick one below the threshold and
          // skip a director.
          amountMinor: facts?.amountMinor ?? (b.amountMinor ?? 0),
          reason: b.reason ?? null,
          currency: facts?.currency ?? undefined,
          // Passed because it has already been read. `decide` asks for itself
          // where a caller does not, so the self-approval bar does not depend
          // on this line being here.
          submittedBy: facts?.submittedBy ?? null,
        });
        return json(ledgerJson({ decision: r.decision, state: r.state }));
      }

      case "withdraw": {
        if (!b.subjectType || !b.subjectId) return json({ error: "What kind of document, and which one?" }, 400);
        if (!b.reason?.trim()) {
          return json({ error: "Withdrawal throws away the approvals already collected, so it has to say why." }, 400);
        }
        /* Withdrawing throws away every approval collected so far and starts
         * the round again, so it takes the same key as giving one: it is
         * un-deciding, an act on the document rather than on the rules.
         *
         * The document is asked which entity it is in, and undoing a decision
         * is not checked more loosely than making it. This used to fall back
         * to the org-wide answer for everything but an expense claim, which is
         * the wider half of the same hole: somebody who could approve in one
         * company could throw away the signatures collected in another. A
         * subject with no register and no decisions on it has no entity to
         * find, and `withdraw` below is left to say there is nothing to
         * withdraw. */
        const facts = await subjectFacts({ orgId, subjectType: b.subjectType, subjectId: b.subjectId, entityId: b.entityId });
        await requirePermission({ orgId, userId, entityId: facts?.entityId ?? b.entityId, permission: decisionPermission(b.subjectType) });
        return json(ledgerJson(await withdraw({
          orgId, subjectType: b.subjectType, subjectId: b.subjectId, withdrawnBy: userId, reason: b.reason,
        })));
      }

      default:
        return json({ error: "Unknown action." }, 400);
    }
  } catch (e) {
    if (e instanceof PermissionError) return json({ error: e.message }, 403);
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}
