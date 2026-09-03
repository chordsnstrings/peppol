import { requireSession } from "@/lib/server/session";
import { assertSameOrigin } from "@/lib/server/platform-admin";
import { json, handleError } from "@/lib/server/http";
import { LedgerError } from "@/lib/server/ledger/post";
import { requirePermission, PermissionError } from "@/lib/server/ledger/permissions";
import { prisma } from "@/lib/server/prisma";

export const runtime = "nodejs";

const NEXT: Record<string, string[]> = {
  open: ["soft_closed"],
  soft_closed: ["open", "hard_closed"],
  hard_closed: ["locked"],
  locked: [],
};

export async function GET(req: Request) {
  try {
    const { orgId } = await requireSession();
    const entityId = new URL(req.url).searchParams.get("entityId");
    if (!entityId) return json({ error: "entityId required" }, 400);
    const periods = await prisma.accountingPeriod.findMany({
      where: { orgId, entityId },
      orderBy: [{ startsOn: "asc" }],
      select: { id: true, label: true, seq: true, startsOn: true, endsOn: true, status: true, isAdjustment: true, closedAt: true },
    });
    return json({ periods });
  } catch (e) {
    if (e instanceof PermissionError) return json({ error: e.message }, 403);
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}

/** Advance a period through its status machine. A locked period never reopens. */
export async function PATCH(req: Request) {
  try {
    await assertSameOrigin(req);
    const { orgId, userId } = await requireSession();
    const b = (await req.json().catch(() => ({}))) as { periodId?: string; status?: string };
    if (!b.periodId || !b.status) return json({ error: "periodId and status are required." }, 400);

    const period = await prisma.accountingPeriod.findFirst({ where: { id: b.periodId, orgId } });
    if (!period) return json({ error: "That accounting period does not exist." }, 404);

    // Closing a month and reopening one are different permissions. Reopening
    // undoes somebody else's decision, and is the one that lets a figure
    // already reported be changed underneath whoever reported it.
    await requirePermission({
      orgId, userId, entityId: period.entityId,
      permission: b.status === "open" ? "period.reopen" : "period.close",
    });

    const allowed = NEXT[period.status] ?? [];
    if (!allowed.includes(b.status)) {
      return json({
        error: period.status === "locked"
          ? `${period.label} is locked. A locked period never reopens — post a correcting entry in an open period instead.`
          : `${period.label} is ${period.status.replace("_", " ")} and cannot move to ${b.status.replace("_", " ")}.`,
      }, 422);
    }

    const updated = await prisma.accountingPeriod.update({
      where: { id: period.id },
      data: { status: b.status, closedAt: b.status === "open" ? null : new Date() },
    });
    return json({ period: { id: updated.id, label: updated.label, status: updated.status } });
  } catch (e) {
    if (e instanceof PermissionError) return json({ error: e.message }, 403);
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}
