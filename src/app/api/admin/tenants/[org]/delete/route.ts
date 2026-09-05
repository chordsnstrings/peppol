import { requireAdminWrite, isSuper, auditData, requestIp } from "@/lib/server/platform-admin";
import { json, handleError } from "@/lib/server/http";
import { prisma } from "@/lib/server/prisma";
import { Prisma } from "@prisma/client";

export const runtime = "nodejs";

/**
 * Every table that holds a tenant's data, derived from the schema.
 *
 * This used to be nine table names written out by hand. The schema has
 * ninety-eight models carrying an orgId, so eighty-nine were left behind —
 * including Account, JournalEntry, JournalLine, Book and every subledger. A
 * workspace deleted for a customer who asked for their data to be erased kept
 * its entire general ledger; and because ids are not reused but are not
 * guaranteed unique across a restore either, an org recreated with the same id
 * would inherit somebody else's books.
 *
 * Derived rather than listed, because a hand-written list is exactly what went
 * stale here: seventy of those models were added after the list was written,
 * and nothing failed at the time.
 *
 * The order is unimportant. Foreign keys are not enforced during the delete —
 * see below — so nothing has to go before anything else.
 */
const ORG_SCOPED_TABLES: string[] = Prisma.dmmf.datamodel.models
  .filter((m) => m.fields.some((f) => f.name === "orgId"))
  // Membership hangs off the organisation and is cascaded by deleting it; the
  // audit log is deliberately kept, which is the whole point of writing it
  // first.
  .filter((m) => m.name !== "Membership" && m.name !== "AdminAuditLog")
  .map((m) => m.dbName ?? m.name);

/**
 * Permanently delete a workspace and all its data. Super only. Requires a reason
 * and a typed confirmation of the workspace name. Audited (the log row survives).
 */
export async function POST(req: Request, ctx: { params: Promise<{ org: string }> }) {
  try {
    const admin = await requireAdminWrite(req);
    if (!isSuper(admin.role)) return json({ error: "Only super admins can delete a tenant" }, 403);
    const { org } = await ctx.params;
    const body = (await req.json().catch(() => ({}))) as { reason?: string; confirmName?: string };
    const reason = body.reason?.trim();
    if (!reason) return json({ error: "A reason is required" }, 400);

    const organization = await prisma.organization.findUnique({ where: { id: org } });
    if (!organization) return json({ error: "Workspace not found" }, 404);
    if (body.confirmName?.trim() !== organization.name) {
      return json({ error: `Type the workspace name exactly to confirm: "${organization.name}"` }, 400);
    }

    const ip = await requestIp();
    const removed: Record<string, number> = {};

    await prisma.$transaction(async (tx) => {
      // Audit FIRST so the record exists even though the org is about to vanish.
      await tx.adminAuditLog.create({
        data: auditData(admin, {
          action: "tenant.delete", targetOrgId: org, reason,
          metadata: { name: organization.name, slug: organization.slug },
        }, ip),
      });

      /*
       * The ledger defends itself against deletion, and rightly so: gl_entry_guard
       * refuses to let a posted entry be removed, because correction is by
       * reversal and a ledger you can delete from is not a ledger. Those guards
       * exist to protect an operating set of books, not to make a tenant's data
       * indestructible when they have asked for it to be erased.
       *
       * So they are turned off for the length of this transaction only.
       * `SET LOCAL` reverts at commit or rollback whatever happens, and it is
       * scoped to this connection — the same tool the test suite uses to reset a
       * fixture. Foreign keys are disabled by the same setting, which is why the
       * order below does not matter.
       */
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");

      for (const table of ORG_SCOPED_TABLES) {
        // Quoted because every table in this schema is PascalCase and Postgres
        // folds an unquoted identifier to lower case. The name comes from the
        // schema rather than from the request, so it cannot carry anything else.
        const n = await tx.$executeRawUnsafe(
          `DELETE FROM "${table.replace(/"/g, "")}" WHERE "orgId" = $1`,
          org,
        );
        if (n > 0) removed[table] = n;
      }

      // Deleting the org cascades its memberships.
      await tx.organization.delete({ where: { id: org } });
    });

    // What was destroyed, so the answer to "is it really gone" is a list rather
    // than a promise.
    return json({
      ok: true,
      tablesConsidered: ORG_SCOPED_TABLES.length,
      rowsRemoved: Object.values(removed).reduce((a, b) => a + b, 0),
      removed,
    });
  } catch (e) {
    return handleError(e);
  }
}
