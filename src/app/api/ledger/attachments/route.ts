import { requireSession } from "@/lib/server/session";
import { assertSameOrigin } from "@/lib/server/platform-admin";
import { json, handleError } from "@/lib/server/http";
import { LedgerError } from "@/lib/server/ledger/post";
import { ledgerJson } from "@/lib/server/ledger/serialize";
import {
  attach, listAttachments, getAttachment, removeAttachment, MAX_BYTES, type SubjectType,
} from "@/lib/server/ledger/attachments";

export const runtime = "nodejs";

/**
 * Documents attached to accounting records.
 *
 * Two reads, kept apart on purpose:
 *
 *   GET ?subjectType=BILL&subjectId=…  → the list, metadata only
 *   GET ?id=…                          → one document, with its bytes
 *
 * The list never carries content. Fifty receipts on one bill would be fifty
 * megabytes of base64 to draw a list of filenames, and a client that only
 * wanted the names has no way to refuse what it was sent. Fetching the bytes is
 * a separate, deliberate request for one document at a time — which is also
 * what makes the integrity check on the way out meaningful: `verified` is
 * computed by re-hashing the bytes actually being handed over.
 */
export async function GET(req: Request) {
  try {
    const { orgId } = await requireSession();
    const url = new URL(req.url);
    const id = url.searchParams.get("id");

    if (id) {
      const doc = await getAttachment({ orgId, id });
      return json(ledgerJson({ attachment: doc }));
    }

    const subjectType = url.searchParams.get("subjectType");
    const subjectId = url.searchParams.get("subjectId");
    if (!subjectType || !subjectId) {
      return json({ error: "Say what the attachments belong to: subjectType and subjectId." }, 400);
    }
    const attachments = await listAttachments({ orgId, subjectType, subjectId });
    return json(ledgerJson({ attachments }));
  } catch (e) {
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}

/** Attach a document. The same bytes twice on one subject is not an error. */
export async function POST(req: Request) {
  try {
    await assertSameOrigin(req);
    const { orgId, userId } = await requireSession();
    const b = (await req.json().catch(() => ({}))) as {
      entityId?: string;
      subjectType?: SubjectType;
      subjectId?: string;
      filename?: string;
      mimeType?: string;
      contentBase64?: string;
    };
    if (!b.subjectType || !b.subjectId) {
      return json({ error: "An attachment has to say what it is attached to." }, 400);
    }
    if (!b.filename || !b.mimeType || !b.contentBase64) {
      return json({ error: "An attachment needs a filename, a type and its content." }, 400);
    }

    const result = await attach({
      orgId,
      entityId: b.entityId,
      subjectType: b.subjectType,
      subjectId: b.subjectId,
      filename: b.filename,
      mimeType: b.mimeType,
      contentBase64: b.contentBase64,
      uploadedBy: userId,
    });
    // A duplicate is reported as such rather than as a new upload: the caller
    // should be able to tell a person "that is already attached".
    return json(ledgerJson({ attachment: result, limitBytes: MAX_BYTES }));
  } catch (e) {
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}

/**
 * Detach a document.
 *
 * There is no attachment history table, so the removal is logged here with the
 * hash and the original uploader. Removing evidence silently is how evidence
 * stops being evidence.
 */
export async function DELETE(req: Request) {
  try {
    await assertSameOrigin(req);
    const { orgId, userId } = await requireSession();
    const id = new URL(req.url).searchParams.get("id");
    if (!id) return json({ error: "Which attachment?" }, 400);

    const removed = await removeAttachment({ orgId, id, removedBy: userId });
    console.info("[attachment removed]", {
      orgId,
      id: removed.id,
      subject: `${removed.subjectType}:${removed.subjectId}`,
      filename: removed.filename,
      sha256: removed.sha256,
      uploadedBy: removed.uploadedBy,
      removedBy: removed.removedBy,
      removedAt: removed.removedAt.toISOString(),
    });
    return json(ledgerJson({ removed }));
  } catch (e) {
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}
