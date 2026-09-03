import { requireSession } from "@/lib/server/session";
import { assertSameOrigin } from "@/lib/server/platform-admin";
import { json, handleError } from "@/lib/server/http";
import { LedgerError } from "@/lib/server/ledger/post";
import {
  listProjects,
  createProject,
  updateProject,
  closeProject,
  projectSummary,
  projectProfitability,
  projectDetail,
  workInProgress,
} from "@/lib/server/ledger/projects";

export const runtime = "nodejs";

/**
 * Job costing. The list of projects comes back on every read so a screen can
 * fill its picker and draw its report from one request, and the report and its
 * drill-down are produced together from the same dimensional read — the detail
 * cannot then disagree with the figure it was opened from.
 *
 * Every amount is already a decimal string of minor units (BigInt never leaves
 * the module as a BigInt), so there is nothing here for JSON to round.
 */
export async function GET(req: Request) {
  try {
    const { orgId } = await requireSession();
    const url = new URL(req.url);
    const entityId = url.searchParams.get("entityId");
    if (!entityId) return json({ error: "entityId is required." }, 400);

    const projects = await listProjects({ orgId, entityId });

    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    const project = url.searchParams.get("project");

    if (project) {
      const profitability = await projectProfitability({
        orgId, entityId, projectCode: project, from: from ?? undefined, to: to ?? undefined,
      });
      const detail = await projectDetail({
        orgId, entityId, projectCode: project, from: profitability.from, to: profitability.to,
      });
      return json({ projects, profitability, detail });
    }

    const asOf = url.searchParams.get("asOf");
    if (asOf) return json({ projects, workInProgress: await workInProgress({ orgId, entityId, asOf }) });

    if (!from || !to) return json({ projects });
    return json({ projects, summary: await projectSummary({ orgId, entityId, from, to }) });
  } catch (e) {
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}

/** Raise a project, change one, or close one. Nothing here touches the ledger. */
export async function POST(req: Request) {
  try {
    await assertSameOrigin(req);
    const { orgId } = await requireSession();
    const b = (await req.json().catch(() => ({}))) as {
      action?: "create" | "update" | "close";
      entityId?: string;
      code?: string;
      name?: string;
      customerName?: string | null;
      startsOn?: string;
      endsOn?: string | null;
      budgetMinor?: string | number;
      status?: string;
    };
    if (!b.entityId) return json({ error: "entityId is required." }, 400);

    switch (b.action) {
      case "create":
        if (!b.code || !b.name || !b.startsOn) {
          return json({ error: "A project needs a code, a name and the date it starts." }, 400);
        }
        return json({
          project: await createProject({
            orgId, entityId: b.entityId, code: b.code, name: b.name,
            customerName: b.customerName, startsOn: b.startsOn, endsOn: b.endsOn,
            budgetMinor: b.budgetMinor, status: b.status,
          }),
        });

      case "update":
        if (!b.code) return json({ error: "Which project? A code is required." }, 400);
        return json({
          project: await updateProject({
            orgId, entityId: b.entityId, code: b.code, name: b.name,
            customerName: b.customerName, endsOn: b.endsOn,
            budgetMinor: b.budgetMinor, status: b.status,
          }),
        });

      case "close":
        if (!b.code) return json({ error: "Which project? A code is required." }, 400);
        return json({
          project: await closeProject({
            orgId, entityId: b.entityId, code: b.code, endsOn: b.endsOn ?? undefined,
          }),
        });

      default:
        return json({ error: "Unknown action. A project is created, updated or closed." }, 400);
    }
  } catch (e) {
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}
