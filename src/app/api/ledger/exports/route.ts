import { requireSession } from "@/lib/server/session";
import { requirePermission, PermissionError } from "@/lib/server/ledger/permissions";
import { assertSameOrigin } from "@/lib/server/platform-admin";
import { json, handleError } from "@/lib/server/http";
import { ledgerJson } from "@/lib/server/ledger/serialize";
import { LedgerError } from "@/lib/server/ledger/post";
import { parseTrialBalance } from "@/lib/server/ledger/opening";
import {
  exportLedger, verifyExport, importTrialBalance, previewImport,
  type ExportFormat, type TrialBalanceRowInput,
} from "@/lib/server/ledger/exports";

export const runtime = "nodejs";

/**
 * Data export and migration.
 *
 * GET builds the bundle and returns it whole — the manifest, the verification,
 * and the contents of every file. The contents travel with the summary on
 * purpose: the screen shows the manifest and then hands the user the very bytes
 * it was computed over, so what is downloaded is what was verified. Serving the
 * files from a second request would mean the reassuring manifest on screen and
 * the file on disk came from two different reads of a ledger that may have moved
 * between them.
 *
 * POST previews or performs a migration. It is a POST rather than a GET because
 * the trial balance being checked is the request body — hundreds of rows of the
 * customer's own financial position, which does not belong in a URL or an access
 * log. Pasted text is read by `parseTrialBalance`, the same reader the opening
 * balances screen uses, so a file that works on one screen works on the other.
 */
export async function GET(req: Request) {
  try {
    const { orgId, userId } = await requireSession();
    const url = new URL(req.url);
    const entityId = url.searchParams.get("entityId");
    if (!entityId) return json({ error: "entityId is required to export a ledger." }, 400);
    /* An export is the widest read in the product: every journal, every account
     * and every balance, in one bundle that then leaves the building. There is
     * nothing narrower to give it, so it takes the read key — and anyone holding
     * the read key on this entity can already see all of this a screen at a
     * time. On this entity is the whole of it: the bundle is one entity's
     * ledger, and the widest read is the last one that should answer to a grant
     * somebody holds somewhere else. */
    await requirePermission({ orgId, userId, entityId, permission: "ledger.read" });

    const format = (url.searchParams.get("format") ?? "json") as ExportFormat;
    if (format !== "csv" && format !== "json") {
      return json({ error: `"${format}" is not an export format. Ask for csv or json.` }, 400);
    }

    const bundle = await exportLedger({
      orgId,
      entityId,
      from: url.searchParams.get("from"),
      to: url.searchParams.get("to"),
      format,
    });
    const verification = verifyExport(bundle);

    // One named file, served as a download. Used where a browser is not doing
    // the saving — a script, or a link somebody wants to bookmark.
    const wanted = url.searchParams.get("file");
    if (wanted) {
      const file = bundle.files.find((f) => f.key === wanted || f.name === wanted);
      if (!file) {
        return json(
          { error: `This export has no file called "${wanted}". It carries ${bundle.files.map((f) => f.name).join(", ")}.` },
          404,
        );
      }
      return new Response(file.content, {
        headers: {
          "content-type": file.contentType,
          "content-disposition": `attachment; filename="${bundle.baseName}-${file.name}"`,
          // An integration that only ever takes the file still learns whether
          // the bundle checked out, instead of finding out from an auditor.
          "x-export-digest": bundle.manifest.digest,
          "x-export-intact": String(verification.intact),
          "x-export-warnings": String(bundle.warnings.length),
          "cache-control": "no-store",
        },
      });
    }

    return json(ledgerJson({ ...bundle, verification }));
  } catch (e) {
    if (e instanceof PermissionError) return json({ error: e.message }, 403);
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}

export async function POST(req: Request) {
  try {
    await assertSameOrigin(req);
    const { orgId, userId } = await requireSession();
    const b = (await req.json().catch(() => ({}))) as {
      action?: "parse" | "preview" | "import";
      entityId?: string;
      asOf?: string;
      rows?: TrialBalanceRowInput[];
      text?: string;
    };

    /* Migrating in loads a trial balance into an empty ledger, which is opening
     * balances by another name. Parsing and previewing are guarded with it
     * because they are the earlier steps of that same screen.
     *
     * The guard waits for the body because the entity being loaded is in it.
     * Parsing pasted text names no entity and legitimately cannot — it reads a
     * file and touches no books — so `b.entityId` is undefined there and the
     * check falls back to the org-wide answer it gave before. */
    await requirePermission({ orgId, userId, entityId: b.entityId, permission: "setup.manage" });

    if (b.action === "parse") {
      if (!b.text) return json({ error: "There is nothing to read." }, 400);
      return json(parseTrialBalance(b.text));
    }

    if (!b.entityId || !b.asOf) return json({ error: "entityId and asOf are required." }, 400);
    const rows = Array.isArray(b.rows) ? b.rows : [];

    if (b.action === "import") {
      return json(ledgerJson(await importTrialBalance({
        orgId, entityId: b.entityId, asOf: b.asOf, rows, actorId: userId,
      })));
    }
    return json(ledgerJson(await previewImport({ orgId, entityId: b.entityId, asOf: b.asOf, rows })));
  } catch (e) {
    if (e instanceof PermissionError) return json({ error: e.message }, 403);
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}
