import { requireSession } from "@/lib/server/session";
import { requirePermission, PermissionError } from "@/lib/server/ledger/permissions";
import { assertSameOrigin } from "@/lib/server/platform-admin";
import { json, handleError } from "@/lib/server/http";
import { prisma } from "@/lib/server/prisma";
import { ledgerJson } from "@/lib/server/ledger/serialize";
import { LedgerError } from "@/lib/server/ledger/post";
import {
  createClaim, addLine, updateLine, removeLine, updateClaim,
  submitClaim, approveClaim, rejectClaim, reopenClaim, postClaim, payClaim,
  claimList, claimDetail,
  type ClaimStatus, type NewClaim, type NewClaimLine,
} from "@/lib/server/ledger/expenses";

export const runtime = "nodejs";

/** The claim list with what is owed to staff, or one claim in full. */
export async function GET(req: Request) {
  try {
    const { orgId, userId } = await requireSession();
    const q = new URL(req.url).searchParams;

    const claimId = q.get("claimId");
    if (claimId) {
      // One claim, addressed by id, so the entity comes off the claim rather
      // than out of the query — the same reason /api/ledger/ar/post reads the
      // document before it asks. Reading it before the guard would leave the
      // whole detail, including what a colleague is owed, open to anybody.
      const detail = await claimDetail({ orgId, claimId });
      const entityOfClaim = detail.claim.entityId;
      await requirePermission({ orgId, userId, entityId: entityOfClaim, permission: "ledger.read" });
      return json(ledgerJson(detail));
    }

    const entityId = q.get("entityId");
    if (!entityId) return json({ error: "entityId required" }, 400);
    /* The claim list carries what the business owes its own staff, name by
     * name. Approving one is `expense.approve` on the POST; reading the list
     * is the ordinary read a bookkeeper needs to pay them. */
    await requirePermission({ orgId, userId, entityId, permission: "ledger.read" });
    return json(ledgerJson(await claimList({
      orgId,
      entityId,
      status: (q.get("status") as ClaimStatus | null) ?? undefined,
      employeeCode: q.get("employeeCode") ?? undefined,
    })));
  } catch (e) {
    if (e instanceof PermissionError) return json({ error: e.message }, 403);
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}

/** Draft, submit, approve, reject, post or pay an expense claim. */
export async function POST(req: Request) {
  try {
    await assertSameOrigin(req);
    const { orgId, userId } = await requireSession();
    const b = (await req.json().catch(() => ({}))) as {
      action?:
        | "create" | "addLine" | "updateLine" | "removeLine" | "update"
        | "submit" | "approve" | "reject" | "reopen" | "post" | "pay";
      entityId?: string;
      claimId?: string;
      lineId?: string;
      claim?: NewClaim;
      line?: NewClaimLine;
      patch?: Parameters<typeof updateClaim>[0]["patch"];
      reason?: string;
      paidOn?: string;
      bankAccount?: string;
      paymentId?: string;
      fxRate?: number;
    };

    /* Approving somebody else's claim is the control this module exists
     * for. Refusing self-approval, which the module already does, is a
     * different question from who may approve at all.
     *
     * The guard waits for the body so that each action is checked against the
     * entity it acts in, and the two kinds of action find that entity in two
     * different places. `create` is the only one that carries an entity, and
     * it is the entity the claim is being raised in. Every other action
     * addresses an existing claim by id, so the entity comes off the claim —
     * the same order the GET above uses and the same reason `ap/post` reads
     * the bill before it asks. Passing `b.entityId` for those asked the
     * org-wide question, because it is undefined on every action but `create`:
     * approving, posting and paying only asked whether you may approve claims
     * somewhere in this workspace, so a grant on one entity answered for every
     * other one. A claim id that matches nothing has no entity to check, and
     * the action below is left to say so — its message for a claim that is not
     * there is the one it always was. */
    const entityOfClaim = b.claimId
      ? (await prisma.expenseClaim.findFirst({ where: { id: b.claimId, orgId }, select: { entityId: true } }))?.entityId
      : undefined;
    const entityOfAction = b.action === "create" ? b.entityId : entityOfClaim;
    await requirePermission({ orgId, userId, entityId: entityOfAction, permission: "expense.approve" });

    switch (b.action) {
      case "create": {
        if (!b.entityId) return json({ error: "entityId required" }, 400);
        if (!b.claim) return json({ error: "A claim needs a reference, an employee and a date." }, 400);
        const claim = await createClaim({ orgId, entityId: b.entityId, claim: b.claim });
        return json(ledgerJson({ claim: { id: claim.id, reference: claim.reference, status: claim.status } }));
      }

      case "addLine": {
        if (!b.claimId || !b.line) return json({ error: "Which claim, and which expense?" }, 400);
        const line = await addLine({ orgId, claimId: b.claimId, line: b.line });
        return json(ledgerJson({ line: { id: line.id } }));
      }

      case "updateLine": {
        if (!b.claimId || !b.lineId || !b.line) {
          return json({ error: "Which claim, which line, and what does the receipt now say?" }, 400);
        }
        const line = await updateLine({ orgId, claimId: b.claimId, lineId: b.lineId, line: b.line });
        return json(ledgerJson({ line: { id: line.id } }));
      }

      case "removeLine":
        if (!b.claimId || !b.lineId) return json({ error: "Which claim, and which line?" }, 400);
        return json(ledgerJson(await removeLine({ orgId, claimId: b.claimId, lineId: b.lineId })));

      case "update": {
        if (!b.claimId || !b.patch) return json({ error: "Which claim, and what changed?" }, 400);
        const claim = await updateClaim({ orgId, claimId: b.claimId, patch: b.patch });
        return json(ledgerJson({ claim: { id: claim.id, reference: claim.reference, status: claim.status } }));
      }

      case "submit": {
        if (!b.claimId) return json({ error: "Which claim?" }, 400);
        const claim = await submitClaim({ orgId, claimId: b.claimId });
        return json(ledgerJson({ claim: { id: claim.id, status: claim.status } }));
      }

      case "approve": {
        if (!b.claimId) return json({ error: "Which claim?" }, 400);
        // The approver is whoever is signed in — never a value the request
        // supplies. Letting the client name the approver would hand the one
        // control this subledger has to the person it exists to constrain.
        const claim = await approveClaim({ orgId, claimId: b.claimId, approverId: userId });
        return json(ledgerJson({ claim: { id: claim.id, status: claim.status, approvedBy: claim.approvedBy } }));
      }

      case "reject": {
        if (!b.claimId) return json({ error: "Which claim?" }, 400);
        if (!b.reason?.trim()) return json({ error: "A rejection has to say why, so the claimant knows what to fix." }, 400);
        const claim = await rejectClaim({ orgId, claimId: b.claimId, approverId: userId, reason: b.reason });
        return json(ledgerJson({ claim: { id: claim.id, status: claim.status, rejectedReason: claim.rejectedReason } }));
      }

      case "reopen": {
        if (!b.claimId) return json({ error: "Which claim?" }, 400);
        const claim = await reopenClaim({ orgId, claimId: b.claimId });
        return json(ledgerJson({ claim: { id: claim.id, status: claim.status } }));
      }

      case "post":
        if (!b.claimId) return json({ error: "Which claim?" }, 400);
        return json(ledgerJson(await postClaim({ orgId, claimId: b.claimId, fxRate: b.fxRate, actorId: userId })));

      case "pay":
        if (!b.claimId) return json({ error: "Which claim?" }, 400);
        return json(ledgerJson(await payClaim({
          orgId, claimId: b.claimId, paidOn: b.paidOn ?? new Date(),
          bankAccount: b.bankAccount, paymentId: b.paymentId, fxRate: b.fxRate, actorId: userId,
        })));

      default:
        return json({ error: "Unknown action." }, 400);
    }
  } catch (e) {
    if (e instanceof PermissionError) return json({ error: e.message }, 403);
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}
