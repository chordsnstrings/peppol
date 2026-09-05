import { requireSession } from "@/lib/server/session";
import { requirePermission, PermissionError } from "@/lib/server/ledger/permissions";
import { assertSameOrigin } from "@/lib/server/platform-admin";
import { json, handleError } from "@/lib/server/http";
import { LedgerError } from "@/lib/server/ledger/post";
import {
  consolidatedStatements,
  groupList,
  groupDetail,
  createGroup,
  addMember,
  removeMember,
} from "@/lib/server/ledger/consolidation";

export const runtime = "nodejs";

/**
 * Group accounts for a consolidation group.
 *
 * Every member's figures come from /api/ledger/statements' own functions, so a
 * member's column here and that entity's own accounts are the same read rather
 * than two reads that can drift.
 *
 * Intercompany eliminations are returned as proposals and applied only when the
 * caller asks for them by name. That is deliberate: a journal line records no
 * counterparty, so an elimination is a judgement, and a GET that silently made
 * one would hide a real imbalance behind a balanced-looking sheet.
 */
export async function GET(req: Request) {
  try {
    const { orgId, userId } = await requireSession();
    /* Group accounts are the members' own statements added together — a read.
     *
     * org-wide: a consolidation group spans entities by definition, so a grant
     * on one member is not what decides whether somebody may see the group.
     * There is no single entity to narrow to — the response adds several of
     * them up — and the group is named by code, with its membership read from
     * the organisation rather than from anything the client supplies. */
    await requirePermission({ orgId, userId, permission: "ledger.read" });
    const url = new URL(req.url);
    const group = url.searchParams.get("group");

    if (!group) return json({ groups: await groupList({ orgId }) });

    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    if (!from || !to) return json({ group: await groupDetail({ orgId, groupCode: group }) });

    const applyEliminations = url.searchParams.get("applyEliminations") === "true";
    const [detail, statements] = await Promise.all([
      groupDetail({ orgId, groupCode: group }),
      consolidatedStatements({ orgId, groupCode: group, from, to, applyEliminations }),
    ]);
    return json({ group: detail, consolidated: statements });
  } catch (e) {
    if (e instanceof PermissionError) return json({ error: e.message }, 403);
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}

/** Create a group, or change who is in it. Nothing here posts. */
export async function POST(req: Request) {
  try {
    await assertSameOrigin(req);
    const { orgId, userId } = await requireSession();
    /* Nothing here posts, but deciding which entities are added together decides
     * what every group statement afterwards says. That is setting the books up
     * rather than keeping them, so it takes the setup key; a "consolidation.manage"
     * key is what this would have asked for if the catalogue had one.
     *
     * org-wide: a group spans entities by definition, and adding one to it or
     * taking one out changes what the whole group reports. `add-member` does
     * name an entity, but narrowing to it would be the wrong check twice over
     * — it would let somebody with a grant on one small subsidiary rewrite the
     * group every other entity is reported in, and it would ask nothing at all
     * of `create`, which names no entity and decides the group exists. */
    await requirePermission({ orgId, userId, permission: "setup.manage" });
    const b = (await req.json().catch(() => ({}))) as {
      action?: "create" | "add-member" | "remove-member";
      code?: string;
      name?: string;
      currency?: string;
      group?: string;
      entityId?: string;
      ownershipBps?: number;
      isParent?: boolean;
    };

    if (b.action === "create") {
      if (!b.code || !b.name) return json({ error: "A group needs a code and a name." }, 400);
      return json({ group: await createGroup({ orgId, code: b.code, name: b.name, currency: b.currency }) });
    }

    if (b.action === "add-member") {
      if (!b.group || !b.entityId) return json({ error: "A member needs a group code and an entityId." }, 400);
      return json({
        group: await addMember({
          orgId, groupCode: b.group, entityId: b.entityId,
          ownershipBps: b.ownershipBps, isParent: b.isParent === true,
        }),
      });
    }

    if (b.action === "remove-member") {
      if (!b.group || !b.entityId) return json({ error: "Removing a member needs a group code and an entityId." }, 400);
      return json({ group: await removeMember({ orgId, groupCode: b.group, entityId: b.entityId }) });
    }

    return json({ error: 'action must be one of "create", "add-member" or "remove-member".' }, 400);
  } catch (e) {
    if (e instanceof PermissionError) return json({ error: e.message }, 403);
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}
