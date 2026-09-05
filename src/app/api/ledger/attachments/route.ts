import { requireSession } from "@/lib/server/session";
import { requirePermission, PermissionError } from "@/lib/server/ledger/permissions";
import { assertSameOrigin } from "@/lib/server/platform-admin";
import { json, handleError } from "@/lib/server/http";
import { LedgerError } from "@/lib/server/ledger/post";
import { prisma } from "@/lib/server/prisma";
import { ledgerJson } from "@/lib/server/ledger/serialize";
import {
  attach, listAttachments, getAttachment, removeAttachment, MAX_BYTES, type SubjectType,
} from "@/lib/server/ledger/attachments";

export const runtime = "nodejs";

/**
 * Which books a subject belongs to, read off the subject itself.
 *
 * A subject id says nothing about the entity it is in, so a request that names
 * both has told us nothing: a caller could name the entity they hold
 * `attachment.add` on and a bill in another one, and the guard would pass for
 * the wrong books — evidence landing on a record its uploader may not touch,
 * and stamped with an entity that makes the GET and the DELETE guard the wrong
 * one afterwards. So every subject this ledger holds in a table of its own is
 * asked directly. This is the same order the two reads below use, and the same
 * reason `approvals` reads an expense claim's entity rather than believing the
 * request about it.
 *
 * INVOICE and BILL are documents in the general store rather than ledger
 * tables, so there is nothing to ask and they fall back to what the request
 * says — the answer this route gave before. That is the remaining gap and it is
 * the same one the list read has for a subject with no evidence on it yet; it
 * closes when those two become rows with an entity on them.
 */
async function entityOfSubject(orgId: string, subjectType: string, subjectId: string): Promise<string | undefined> {
  const where = { id: subjectId, orgId };
  const select = { entityId: true };
  switch (subjectType) {
    case "JOURNAL_ENTRY": return (await prisma.journalEntry.findFirst({ where, select }))?.entityId;
    case "EXPENSE_CLAIM": return (await prisma.expenseClaim.findFirst({ where, select }))?.entityId;
    case "ASSET": return (await prisma.fixedAsset.findFirst({ where, select }))?.entityId;
    case "BANK_LINE": return (await prisma.bankStatementLine.findFirst({ where, select }))?.entityId;
    default: return undefined;
  }
}

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
    const { orgId, userId } = await requireSession();
    /* Evidence for a document is part of reading the document — `ledger.read`.
     *
     * An entry says what was decided; the attachment is what it was decided
     * on. An audit trail whose evidence only some of its readers may see is
     * not an audit trail, and somebody who can already open the bill has
     * gained nothing by being refused the supplier's PDF of it.
     *
     * One key is honest here only because every subject type this module
     * accepts — journal entry, invoice, bill, expense claim, asset, bank line
     * — is a record `ledger.read` already covers. If a payslip ever becomes a
     * subject type this has to branch on the subject instead of answering with
     * one key, because a receipt and a payslip are not the same read.
     *
     * The entity comes off the record and never off the request. Neither an
     * attachment id nor a subject id is entity-scoped, so a caller naming one
     * has told us nothing about which books it belongs to — the row has. Both
     * branches therefore read the metadata first and check afterwards, which
     * is the same order `journals/[id]/reverse` uses and for the same reason:
     * a grant on one entity must not open another entity's evidence. Nothing
     * is returned until the check passes. A row attached before the entity
     * column was recorded carries none, and falls back to the org-wide answer
     * this route gave before. */
    const url = new URL(req.url);
    const id = url.searchParams.get("id");

    if (id) {
      const doc = await getAttachment({ orgId, id });
      await requirePermission({ orgId, userId, entityId: doc.entityId ?? undefined, permission: "ledger.read" });
      return json(ledgerJson({ attachment: doc }));
    }

    const subjectType = url.searchParams.get("subjectType");
    const subjectId = url.searchParams.get("subjectId");
    if (!subjectType || !subjectId) {
      return json({ error: "Say what the attachments belong to: subjectType and subjectId." }, 400);
    }
    const attachments = await listAttachments({ orgId, subjectType, subjectId });
    // Everything attached to one subject sits in that subject's entity, so the
    // first row that names one answers for the whole list. An empty list has no
    // entity to check because it discloses nothing to check.
    const listEntityId = attachments.find((a) => a.entityId)?.entityId ?? undefined;
    await requirePermission({ orgId, userId, entityId: listEntityId, permission: "ledger.read" });
    return json(ledgerJson({ attachments }));
  } catch (e) {
    if (e instanceof PermissionError) return json({ error: e.message }, 403);
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
    /* Attaching evidence writes into the record the books rest on, and it now
     * has the key it wanted: `attachment.add`. A claimant photographing the
     * receipt for their own claim should not need the power to post journals by
     * hand, which is what `ledger.post` was asking of them.
     *
     * The key still does not follow the subject — attaching to a bill and
     * attaching to an expense claim ask the same thing — and that remains the
     * gap worth knowing about. Splitting it means a key per subject type, and
     * the honest version of that is for `attach()` to ask the subject who may
     * put evidence behind it. Removing evidence is a different act again and is
     * guarded harder, on the DELETE below.
     *
     * The entity is the record's and not the request's, for the reason written
     * above `entityOfSubject`. It is also what the row is stamped with, so the
     * entity a later read or removal is checked against is the entity the
     * evidence actually sits in. */
    const entityOfRecord = (await entityOfSubject(orgId, b.subjectType, b.subjectId)) ?? b.entityId;
    await requirePermission({ orgId, userId, entityId: entityOfRecord, permission: "attachment.add" });

    const result = await attach({
      orgId,
      entityId: entityOfRecord,
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
    if (e instanceof PermissionError) return json({ error: e.message }, 403);
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
    /* Detaching is guarded harder than attaching, with `ledger.reverse`.
     * Taking evidence off a posted record is a correction to that record, and
     * "correct a posted entry" is what that key names. Under the shipped roles
     * the bookkeeper may add a receipt and only the accountant or the owner
     * may take one away, which is the right way round: as the module puts it,
     * removing evidence silently is how evidence stops being evidence, and the
     * console line below is the only history there is.
     *
     * Which books the correction lands in is read off the row, because an
     * attachment id says nothing about the entity it belongs to and a caller
     * who could name that entity could name one they hold `ledger.reverse` on
     * and then strip the evidence off another entity's bill. A row that is not
     * there has no entity to check, and `removeAttachment` below is left to
     * say so — the message for a missing attachment is the one it always was. */
    const existing = await prisma.attachment.findFirst({
      where: { id, orgId },
      select: { entityId: true },
    });
    await requirePermission({ orgId, userId, entityId: existing?.entityId ?? undefined, permission: "ledger.reverse" });

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
    if (e instanceof PermissionError) return json({ error: e.message }, 403);
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}
