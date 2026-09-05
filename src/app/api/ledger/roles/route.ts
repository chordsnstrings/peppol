import { requireSession } from "@/lib/server/session";
import { assertSameOrigin } from "@/lib/server/platform-admin";
import { json, handleError } from "@/lib/server/http";
import { LedgerError } from "@/lib/server/ledger/post";
import { ledgerJson } from "@/lib/server/ledger/serialize";
import {
  rolesOverview, createRole, updateRole, assignRole, revokeRole,
  seedBuiltInRoles, check, requirePermission, PermissionError,
} from "@/lib/server/ledger/permissions";

export const runtime = "nodejs";

/** The roles, the people, and what each of them can actually do. */
export async function GET(req: Request) {
  try {
    const { orgId, userId } = await requireSession();
    const q = new URL(req.url).searchParams;

    const permission = q.get("check");
    if (permission) {
      return json(ledgerJson(await check({
        orgId, userId, permission, entityId: q.get("entityId") ?? undefined,
      })));
    }
    return json(ledgerJson(await rolesOverview({ orgId })));
  } catch (e) {
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}

/**
 * Every write here needs `roles.manage`, checked against the caller. Deciding
 * who may do what is itself a permission, or the first person to find this
 * endpoint gives themselves everything.
 */
export async function POST(req: Request) {
  try {
    await assertSameOrigin(req);
    const { orgId, userId } = await requireSession();
    const b = (await req.json().catch(() => ({}))) as {
      action?: "seed" | "create" | "update" | "assign" | "revoke";
      code?: string;
      name?: string;
      description?: string;
      permissions?: string[];
      userId?: string;
      roleCode?: string;
      entityId?: string;
    };

    /* `assign` and `revoke` do carry an entity, but it is the entity the grant
     * is FOR, not the entity this act happens in. Seeding, creating and
     * updating a role name none at all and change what every entity's roles
     * mean.
     *
     * org-wide: deciding who may do what administers the whole workspace, not
     * one set of books. Narrowing to the entity in the body would ask whether
     * you may administer the company you are handing somebody a role on, which
     * is the weaker question — it would let a grant on one subsidiary be
     * enough to give somebody a role covering every entity, since a role can
     * be assigned on "*". */
    await requirePermission({ orgId, userId, permission: "roles.manage" });

    switch (b.action) {
      case "seed":
        return json(ledgerJson(await seedBuiltInRoles({ orgId })));

      case "create":
        if (!b.code || !b.name || !b.permissions) {
          return json({ error: "A role needs a code, a name and the permissions it grants." }, 400);
        }
        return json(ledgerJson({
          role: await createRole({
            orgId, code: b.code, name: b.name, description: b.description, permissions: b.permissions,
          }),
        }));

      case "update":
        if (!b.code) return json({ error: "Which role?" }, 400);
        return json(ledgerJson({
          role: await updateRole({
            orgId, code: b.code, name: b.name, description: b.description, permissions: b.permissions,
          }),
        }));

      case "assign":
        if (!b.userId || !b.roleCode) return json({ error: "Which person, and which role?" }, 400);
        return json(ledgerJson({
          assignment: await assignRole({
            orgId, userId: b.userId, roleCode: b.roleCode, entityId: b.entityId, grantedBy: userId,
          }),
        }));

      case "revoke":
        if (!b.userId || !b.roleCode) return json({ error: "Which person, and which role?" }, 400);
        return json(ledgerJson(await revokeRole({
          orgId, userId: b.userId, roleCode: b.roleCode, entityId: b.entityId,
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
