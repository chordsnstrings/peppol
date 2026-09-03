import { requireSession } from "@/lib/server/session";
import { assertSameOrigin } from "@/lib/server/platform-admin";
import { json, handleError } from "@/lib/server/http";
import { prisma } from "@/lib/server/prisma";
import { ledgerJson } from "@/lib/server/ledger/serialize";
import { LedgerError } from "@/lib/server/ledger/post";
import { totalsOf } from "@/lib/server/ledger/expenses";
import {
  setRule, listRules, deactivateRule,
  approvalState, decide, withdraw, pendingFor,
  type SubjectType, type DecisionKind,
} from "@/lib/server/ledger/approvals";

export const runtime = "nodejs";

/**
 * An expense claim is the one subject this ledger holds in a table of its own,
 * so its amount and its claimant are read from that table rather than taken
 * from the request. Both matter: a client that could name the amount could pick
 * one below the threshold and skip a director, and a client that could name the
 * claimant could name somebody else and approve its own claim.
 */
async function subjectFacts(orgId: string, subjectType: SubjectType, subjectId: string) {
  if (subjectType !== "EXPENSE_CLAIM") return null;
  const claim = await prisma.expenseClaim.findFirst({
    where: { id: subjectId, orgId },
    include: { lines: { select: { netMinor: true, vatMinor: true, vatRecoverable: true } } },
  });
  if (!claim) return null;
  return {
    entityId: claim.entityId,
    amountMinor: totalsOf(claim.lines).totalMinor,
    submittedBy: claim.employeeCode,
  };
}

/** The rules in force and this person's queue, or the state of one subject. */
export async function GET(req: Request) {
  try {
    const { orgId, userId } = await requireSession();
    const q = new URL(req.url).searchParams;

    const subjectId = q.get("subjectId");
    const subjectType = q.get("subjectType") as SubjectType | null;
    if (subjectId && subjectType) {
      const entityId = q.get("entityId");
      if (!entityId) return json({ error: "entityId required" }, 400);
      const facts = await subjectFacts(orgId, subjectType, subjectId);
      return json(ledgerJson({
        state: await approvalState({
          orgId,
          entityId: facts?.entityId ?? entityId,
          subjectType,
          subjectId,
          amountMinor: facts?.amountMinor ?? (q.get("amountMinor") ?? "0"),
        }),
      }));
    }

    const entityId = q.get("entityId");
    if (!entityId) return json({ error: "entityId required" }, 400);

    // One request, because the screen is useless without both halves: the rules
    // say what the business asks for, the queue says what it is waiting on.
    const [rules, pending] = await Promise.all([
      listRules({ orgId, entityId, includeInactive: q.get("includeInactive") === "1" }),
      pendingFor({ orgId, userId, entityId }),
    ]);
    return json(ledgerJson({ rules, pending }));
  } catch (e) {
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
        const facts = await subjectFacts(orgId, b.subjectType, b.subjectId);
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
          amountMinor: facts?.amountMinor ?? (b.amountMinor ?? 0),
          reason: b.reason ?? null,
          submittedBy: facts?.submittedBy ?? null,
        });
        return json(ledgerJson({ decision: r.decision, state: r.state }));
      }

      case "withdraw": {
        if (!b.subjectType || !b.subjectId) return json({ error: "What kind of document, and which one?" }, 400);
        if (!b.reason?.trim()) {
          return json({ error: "Withdrawal throws away the approvals already collected, so it has to say why." }, 400);
        }
        return json(ledgerJson(await withdraw({
          orgId, subjectType: b.subjectType, subjectId: b.subjectId, withdrawnBy: userId, reason: b.reason,
        })));
      }

      default:
        return json({ error: "Unknown action." }, 400);
    }
  } catch (e) {
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}
