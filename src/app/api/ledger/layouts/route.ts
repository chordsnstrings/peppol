import { requireSession } from "@/lib/server/session";
import { requirePermission, PermissionError } from "@/lib/server/ledger/permissions";
import { assertSameOrigin } from "@/lib/server/platform-admin";
import { json, handleError } from "@/lib/server/http";
import { ledgerJson } from "@/lib/server/ledger/serialize";
import { LedgerError } from "@/lib/server/ledger/post";
import {
  listLayouts, getLayout, saveLayout, setLayoutStatus,
  renderLayout, duplicateLayout, seedStarterLayouts,
  STARTER_LAYOUTS,
  type LayoutBasis, type LayoutInput, type LayoutRow,
} from "@/lib/server/ledger/layouts";

export const runtime = "nodejs";

/**
 * Saved report layouts, and the reports they render.
 *
 * The figures come from the same read as /api/ledger/statements, so a custom
 * profit and loss cannot disagree with the standard one — and where it does,
 * the coverage block in the response says by how much and which account is
 * missing, rather than leaving the reader to trust a total.
 */
export async function GET(req: Request) {
  try {
    const { orgId, userId } = await requireSession();
    const q = new URL(req.url).searchParams;
    const entityId = q.get("entityId");
    if (!entityId) return json({ error: "entityId is required." }, 400);
    /* Listing layouts, and rendering one, are both reads of the statements —
     * of the entity's statements, so the grant has to cover that entity. */
    await requirePermission({ orgId, userId, entityId, permission: "ledger.read" });

    if (q.get("view") === "render") {
      const code = q.get("code");
      const to = q.get("to");
      if (!code || !to) return json({ error: "code and to are required to render a layout." }, 400);
      return json(
        ledgerJson(
          await renderLayout({ orgId, entityId, code, from: q.get("from") ?? undefined, to }),
        ),
      );
    }

    const code = q.get("code");
    if (code) return json(ledgerJson(await getLayout({ orgId, entityId, code })));

    return json(
      ledgerJson({
        layouts: await listLayouts({ orgId, entityId, includeArchived: q.get("archived") === "1" }),
        starters: STARTER_LAYOUTS.map((s) => ({ code: s.code, name: s.name, basis: s.basis })),
      }),
    );
  } catch (e) {
    if (e instanceof PermissionError) return json({ error: e.message }, 403);
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}

/**
 * Save a layout, preview one still being edited, copy one to another entity,
 * seed the starting pair, or archive one.
 *
 * The preview action takes the rows in the body rather than a saved code so the
 * editor renders exactly what is on screen — including the refusals, which are
 * the point of the screen. A layout that will not validate never reaches the
 * database, so the preview is where a forward reference or a missing account is
 * found, not the file.
 */
export async function POST(req: Request) {
  try {
    await assertSameOrigin(req);
    const { orgId, userId } = await requireSession();
    const b = (await req.json().catch(() => ({}))) as {
      action?: "save" | "preview" | "duplicate" | "seed" | "archive";
      entityId?: string;
      code?: string;
      name?: string;
      basis?: LayoutBasis;
      rows?: LayoutRow[];
      layout?: LayoutInput;
      from?: string;
      to?: string;
      toEntityId?: string;
      newCode?: string;
      status?: "active" | "archived";
      overwrite?: boolean;
    };
    if (!b.entityId) return json({ error: "entityId is required." }, 400);
    /* Saving, copying, seeding or archiving a layout decides how the statements
     * are shown to everybody afterwards, so it goes with setting the books up.
     * A preview is the exception: it renders the rows in the body and writes
     * nothing, so it is a report request and takes the read key.
     *
     * Either way it is one entity's statements being shaped or drawn, and the
     * entity is in the body, so the guard waits for the body. `duplicate` is
     * the one to watch: it reads a layout out of `entityId` and writes it into
     * `toEntityId`, and only the source is checked here — the copy can still
     * land in an entity the caller holds nothing on. */
    const key = b.action === "preview" ? "ledger.read" : "setup.manage";
    await requirePermission({ orgId, userId, entityId: b.entityId, permission: key });

    switch (b.action) {
      case "preview": {
        if (!b.layout || !b.to) return json({ error: "A preview needs a layout and a date to draw it to." }, 400);
        return json(
          ledgerJson(
            await renderLayout({ orgId, entityId: b.entityId, layout: b.layout, from: b.from, to: b.to }),
          ),
        );
      }
      case "duplicate": {
        if (!b.code || !b.toEntityId) {
          return json({ error: "A copy needs the layout code and the entity to copy it to." }, 400);
        }
        return json(
          ledgerJson(
            await duplicateLayout({
              orgId,
              from: { entityId: b.entityId, code: b.code },
              toEntityId: b.toEntityId,
              code: b.newCode,
              name: b.name,
              overwrite: b.overwrite === true,
            }),
          ),
        );
      }
      case "seed":
        return json(
          ledgerJson(await seedStarterLayouts({ orgId, entityId: b.entityId, overwrite: b.overwrite === true })),
        );
      case "archive": {
        if (!b.code) return json({ error: "Name the layout to archive." }, 400);
        return json(
          ledgerJson(
            await setLayoutStatus({
              orgId, entityId: b.entityId, code: b.code, status: b.status === "active" ? "active" : "archived",
            }),
          ),
        );
      }
      default: {
        if (!b.code || !b.name || !b.basis) {
          return json({ error: "A layout needs a code, a name and a basis." }, 400);
        }
        return json(
          ledgerJson(
            await saveLayout({
              orgId, entityId: b.entityId, code: b.code, name: b.name,
              basis: b.basis, rows: b.rows, status: b.status,
            }),
          ),
        );
      }
    }
  } catch (e) {
    if (e instanceof PermissionError) return json({ error: e.message }, 403);
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}
