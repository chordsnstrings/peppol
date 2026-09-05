import { requireSession } from "@/lib/server/session";
import { assertSameOrigin } from "@/lib/server/platform-admin";
import { json, handleError } from "@/lib/server/http";
import { ledgerJson } from "@/lib/server/ledger/serialize";
import { LedgerError } from "@/lib/server/ledger/post";
import { requirePermission, PermissionError } from "@/lib/server/ledger/permissions";
import {
  proposeRun, excludeItem, includeItem, approveRun, releaseRun, cancelRun,
  bankFile, runList, runDetail,
  type Beneficiary, type RunStatus,
} from "@/lib/server/ledger/payment-runs";

export const runtime = "nodejs";

/** The runs for an entity, or one run in full with the entries it posted. */
export async function GET(req: Request) {
  try {
    const { orgId, userId } = await requireSession();
    const q = new URL(req.url).searchParams;

    const runId = q.get("runId");
    if (runId) return json(ledgerJson(await runDetail({ orgId, runId })));

    const entityId = q.get("entityId");
    if (!entityId) return json({ error: "entityId required" }, 400);
    /* A run and its items are a read of what is owed. Proposing, approving and
     * releasing each have their own key, on the POST. */
    await requirePermission({ orgId, userId, entityId, permission: "ledger.read" });
    const status = (q.get("status") as RunStatus | null) ?? undefined;
    return json(ledgerJson(await runList({ orgId, entityId, status })));
  } catch (e) {
    if (e instanceof PermissionError) return json({ error: e.message }, 403);
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}

/**
 * Everything that moves a run along: proposing it, editing what it pays,
 * approving it, releasing the money, cancelling it, and building the file the
 * bank uploads.
 *
 * Two things are taken from the session rather than from the request, because
 * they are claims about who is acting and a caller must not be able to make
 * them about somebody else:
 *
 *   - `approvedBy` is always the signed-in user. You approve as yourself.
 *   - `actorId` on the release is the same, so the journal entries name who
 *     let the money out.
 *
 * `submittedBy` — who prepared the run — comes from the request, and that is a
 * known weakness worth stating rather than hiding: PaymentRun has no
 * preparedBy column, so there is nothing on the run to compare the approver
 * against. Omitting it in the request means the self-approval check cannot be
 * made. The fix is a column, not more validation here; until then the screen
 * asks for the preparer's name and passes it.
 *
 * The bank file comes back as text inside JSON rather than as a download, so
 * the operator can read what is about to reach the bank before it does — the
 * same choice the payroll route makes for the WPS file.
 */
export async function POST(req: Request) {
  try {
    await assertSameOrigin(req);
    const { orgId, userId } = await requireSession();
    const b = (await req.json().catch(() => ({}))) as {
      action?: "propose" | "exclude" | "include" | "approve" | "release" | "cancel" | "bank-file";
      entityId?: string;
      runId?: string;
      itemId?: string;
      reason?: string;
      /** Proposal. */
      runDate?: string;
      dueBy?: string;
      bankAccount?: string;
      currency?: string;
      reference?: string;
      /** Approval: who prepared the run, so self-approval can be refused. */
      submittedBy?: string;
      /** Release. */
      releasedOn?: string;
      /** Bank file. */
      beneficiaries?: Beneficiary[];
    };

    // Proposing, approving and releasing are three permissions on purpose:
    // they are the three hands a payment is meant to pass through, and the
    // roles this product ships put them in different ones.
    const NEEDS: Record<string, string> = {
      propose: "payment_run.propose",
      exclude: "payment_run.propose",
      include: "payment_run.propose",
      cancel: "payment_run.propose",
      approve: "payment_run.approve",
      release: "payment_run.release",
      "bank-file": "payment_run.release",
    };
    if (b.action && NEEDS[b.action]) {
      await requirePermission({ orgId, userId, entityId: b.entityId, permission: NEEDS[b.action] });
    }

    switch (b.action) {
      case "propose": {
        if (!b.entityId) return json({ error: "entityId required" }, 400);
        if (!b.runDate) return json({ error: "A payment run needs the date the money moves." }, 400);
        return json(ledgerJson(await proposeRun({
          orgId, entityId: b.entityId, runDate: b.runDate, dueBy: b.dueBy,
          bankAccount: b.bankAccount, currency: b.currency, reference: b.reference,
          // Whoever is signed in is the preparer. Taking it from the request
          // would let a caller name somebody else and then approve its own run.
          preparedBy: userId,
        })));
      }

      case "exclude": {
        if (!b.runId || !b.itemId) return json({ error: "Which run, and which payment?" }, 400);
        return json(ledgerJson(await excludeItem({ orgId, runId: b.runId, itemId: b.itemId, reason: b.reason ?? "" })));
      }

      case "include": {
        if (!b.runId || !b.itemId) return json({ error: "Which run, and which payment?" }, 400);
        return json(ledgerJson(await includeItem({ orgId, runId: b.runId, itemId: b.itemId, reason: b.reason })));
      }

      case "approve": {
        if (!b.runId) return json({ error: "Which run?" }, 400);
        return json(ledgerJson(await approveRun({
          orgId, runId: b.runId, approvedBy: userId, submittedBy: b.submittedBy,
        })));
      }

      case "release": {
        if (!b.runId) return json({ error: "Which run?" }, 400);
        return json(ledgerJson(await releaseRun({
          orgId, runId: b.runId, releasedOn: b.releasedOn, actorType: "HUMAN", actorId: userId,
        })));
      }

      case "cancel": {
        if (!b.runId) return json({ error: "Which run?" }, 400);
        return json(ledgerJson(await cancelRun({ orgId, runId: b.runId, reason: b.reason ?? "" })));
      }

      case "bank-file": {
        if (!b.runId) return json({ error: "Which run?" }, 400);
        return json(ledgerJson(await bankFile({ orgId, runId: b.runId, beneficiaries: b.beneficiaries ?? [] })));
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
