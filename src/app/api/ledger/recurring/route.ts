import { requireSession } from "@/lib/server/session";
import { assertSameOrigin } from "@/lib/server/platform-admin";
import { json, handleError } from "@/lib/server/http";
import { LedgerError } from "@/lib/server/ledger/post";
import {
  createTemplate,
  updateTemplate,
  pauseTemplate,
  resumeTemplate,
  endTemplate,
  dueTemplates,
  runRecurring,
  templateStatus,
  type NewTemplate,
} from "@/lib/server/ledger/recurring";

export const runtime = "nodejs";

/** The standing instructions: when each last ran, when it is next due, what is behind. */
export async function GET(req: Request) {
  try {
    const { orgId } = await requireSession();
    const url = new URL(req.url);
    const entityId = url.searchParams.get("entityId");
    if (!entityId) return json({ error: "entityId required" }, 400);
    const asOf = url.searchParams.get("asOf") ?? undefined;
    return json(await templateStatus({ orgId, entityId, asOf }));
  } catch (e) {
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}

/** Save, pause, resume or retire a template — or post a period's worth of them. */
export async function POST(req: Request) {
  try {
    await assertSameOrigin(req);
    const { orgId, userId } = await requireSession();
    const b = (await req.json().catch(() => ({}))) as {
      action?: "create" | "update" | "pause" | "resume" | "end" | "due" | "run";
      entityId?: string;
      template?: NewTemplate;
      patch?: Partial<NewTemplate>;
      code?: string;
      endsOn?: string;
      period?: string;
    };
    if (!b.entityId) return json({ error: "entityId required" }, 400);
    const entityId = b.entityId;

    switch (b.action) {
      case "create": {
        if (!b.template?.code || !b.template?.name || !b.template?.startsOn) {
          return json({ error: "A recurring template needs a code, a name and the month it starts." }, 400);
        }
        // The lines are validated inside createTemplate, on purpose: a template
        // that would fail every month at midnight never reaches the database.
        const t = await createTemplate({ orgId, entityId, template: b.template });
        return json({ template: { id: t.id, code: t.code, name: t.name, kind: t.kind } });
      }

      case "update": {
        if (!b.code) return json({ error: "Which template?" }, 400);
        if (!b.patch) return json({ error: "Nothing to change." }, 400);
        const t = await updateTemplate({ orgId, entityId, code: b.code, patch: b.patch });
        return json({ template: { id: t.id, code: t.code, name: t.name, kind: t.kind } });
      }

      case "pause": {
        if (!b.code) return json({ error: "Which template?" }, 400);
        const t = await pauseTemplate({ orgId, entityId, code: b.code });
        return json({ template: { code: t.code, status: t.status } });
      }

      case "resume": {
        if (!b.code) return json({ error: "Which template?" }, 400);
        const t = await resumeTemplate({ orgId, entityId, code: b.code });
        return json({ template: { code: t.code, status: t.status } });
      }

      case "end": {
        if (!b.code) return json({ error: "Which template?" }, 400);
        const t = await endTemplate({ orgId, entityId, code: b.code, endsOn: b.endsOn });
        return json({ template: { code: t.code, status: t.status } });
      }

      case "due": {
        if (!b.period) return json({ error: "Which month?" }, 400);
        const r = await dueTemplates({ orgId, entityId, period: b.period });
        // The templates themselves carry Dates and a JSON blob the client has
        // no use for; only what is due, by name.
        return json({
          period: r.period,
          due: r.due.map((t) => ({ code: t.code, name: t.name, kind: t.kind, autoReverse: t.autoReverse })),
          skipped: r.skipped,
        });
      }

      case "run":
        if (!b.period) return json({ error: "Which month?" }, 400);
        return json(
          await runRecurring({ orgId, entityId, period: b.period, actorType: "HUMAN", actorId: userId }),
        );

      default:
        return json({ error: "Unknown action." }, 400);
    }
  } catch (e) {
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}
