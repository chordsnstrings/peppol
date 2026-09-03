import { createHash } from "node:crypto";
import { prisma } from "@/lib/server/prisma";
import { LedgerError } from "./post";

/**
 * Documents attached to accounting records — the receipt behind the expense
 * claim, the supplier PDF behind the bill, the bank's letter behind the charge.
 *
 * An entry says what was decided; the attachment is the evidence it was decided
 * on. The two only stay connected if the evidence cannot drift, so every file
 * is stored alongside the SHA-256 of its bytes and reading one back re-hashes
 * what is actually in the column. A receipt quietly swapped after approval is
 * precisely what an audit is looking for, and it is invisible to a system that
 * records only a filename.
 *
 * The bytes live as base64 in a TEXT column in the same database as the ledger.
 * That is a deliberate small-scale choice rather than a blob store, and the
 * size ceiling below is what keeps the choice honest.
 */

export const SUBJECT_TYPES = [
  "JOURNAL_ENTRY",
  "INVOICE",
  "BILL",
  "EXPENSE_CLAIM",
  "ASSET",
  "BANK_LINE",
] as const;
export type SubjectType = (typeof SUBJECT_TYPES)[number];

/**
 * 5 MB of file, measured on the decoded bytes.
 *
 * Base64 inflates by a third, so a 5 MB scan is a ~6.8 MB row that Postgres
 * TOASTs out of line — fine for a photographed receipt or a two-page PDF, and
 * the wrong tool for anything larger. The ceiling is not a storage limit so
 * much as a refusal to let the ledger database become a file server: a 200 MB
 * scan does not belong in a row that a journal query might select.
 */
export const MAX_BYTES = 5 * 1024 * 1024;

/**
 * What an accounting system will hold as evidence: documents and pictures of
 * documents, nothing that executes. The list is an allowlist rather than a
 * blocklist because the interesting attack is always the type nobody thought
 * to ban, and a finance system that will store and hand back an arbitrary
 * binary is a liability regardless of how carefully the UI renders it.
 */
const ACCEPTED: Record<string, string> = {
  "application/pdf": "PDF",
  "image/jpeg": "JPEG",
  "image/png": "PNG",
  "image/webp": "WebP",
  "text/csv": "CSV",
  "text/plain": "plain text",
};

const ACCEPTED_LIST = "PDF, JPEG, PNG, WebP, CSV or plain text";

export interface AttachmentMeta {
  id: string;
  orgId: string;
  entityId: string | null;
  subjectType: string;
  subjectId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  uploadedBy: string | null;
  uploadedAt: Date;
}

/** The metadata columns, and never `content`. Used by every list-shaped read. */
const META_SELECT = {
  id: true,
  orgId: true,
  entityId: true,
  subjectType: true,
  subjectId: true,
  filename: true,
  mimeType: true,
  sizeBytes: true,
  sha256: true,
  uploadedBy: true,
  uploadedAt: true,
} as const;

export interface AttachResult extends AttachmentMeta {
  /**
   * True when these exact bytes were already attached to this subject and the
   * existing row was returned instead of a second copy. The caller is told
   * rather than left to infer it, because "uploaded" and "already there" are
   * different things to say to a person who has just pressed the button twice.
   */
  deduplicated: boolean;
}

export interface AttachInput {
  orgId: string;
  entityId?: string;
  subjectType: SubjectType | string;
  subjectId: string;
  filename: string;
  mimeType: string;
  /** The file, base64. A `data:` URL from a browser FileReader is accepted. */
  contentBase64: string;
  uploadedBy?: string;
}

/**
 * Attach a document to an accounting record.
 *
 * The hash is taken over the DECODED bytes, not over the base64, so the same
 * file transmitted with different line wrapping — or with a data: prefix — is
 * recognised as the same file. What gets stored is the canonical re-encoding
 * of those bytes, so the column and the hash can never disagree merely because
 * of how the upload was formatted.
 */
export async function attach(input: AttachInput): Promise<AttachResult> {
  const filename = input.filename?.trim() ?? "";
  if (!filename) throw new LedgerError("An attachment needs a filename; otherwise nobody can say what it is.");
  if (!input.subjectId?.trim()) throw new LedgerError("An attachment has to be attached to something.");

  if (!(SUBJECT_TYPES as readonly string[]).includes(input.subjectType)) {
    throw new LedgerError(
      `"${input.subjectType}" is not something documents can be attached to. ` +
        `Use one of ${SUBJECT_TYPES.join(", ")}.`,
    );
  }

  // "text/plain; charset=utf-8" is the same type as "text/plain"; the parameter
  // says how to read it, not what it is.
  const mimeType = (input.mimeType ?? "").split(";")[0].trim().toLowerCase();
  if (!ACCEPTED[mimeType]) {
    throw new LedgerError(
      `${filename} is ${input.mimeType || "of no stated type"}, which this system does not accept. ` +
        `Attach a ${ACCEPTED_LIST} file instead.`,
    );
  }

  const bytes = decodeBase64(input.contentBase64 ?? "", filename);
  if (bytes.length === 0) {
    throw new LedgerError(`${filename} is empty. An empty file is not evidence of anything.`);
  }
  if (bytes.length > MAX_BYTES) {
    // The byte count as well as the megabytes: a file one byte over would
    // otherwise be refused with "is 5 MB and the limit is 5 MB", which reads
    // like a bug rather than a limit.
    throw new LedgerError(
      `${filename} is ${mb(bytes.length)} MB (${group(bytes.length)} bytes) and the limit is ` +
        `${mb(MAX_BYTES)} MB (${group(MAX_BYTES)} bytes). ` +
        `Attachments are stored inside the ledger database, so a large scan belongs in a document store ` +
        `with a link to it here — reduce the file or attach a smaller copy.`,
    );
  }

  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const content = bytes.toString("base64");

  /**
   * Deduplication is per subject, not per organisation. The same standard
   * terms PDF attached to fifty invoices is fifty genuine attachments — each
   * invoice needs its own evidence — while the same receipt attached twice to
   * one bill is one receipt and a double click.
   */
  const existing = await prisma.attachment.findFirst({
    where: {
      orgId: input.orgId,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      sha256,
    },
    select: META_SELECT,
    orderBy: { uploadedAt: "asc" },
  });
  if (existing) return { ...existing, deduplicated: true };

  const created = await prisma.attachment.create({
    data: {
      orgId: input.orgId,
      entityId: input.entityId ?? null,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      filename,
      mimeType,
      sizeBytes: bytes.length,
      sha256,
      content,
      uploadedBy: input.uploadedBy ?? null,
    },
    select: META_SELECT,
  });
  return { ...created, deduplicated: false };
}

/**
 * What is attached to a record — metadata only.
 *
 * The content column is deliberately not selected. A bill with fifty scanned
 * receipts would otherwise ship fifty megabytes to draw a list of filenames,
 * and the caller that only wanted names has no way to opt out of what it never
 * asked for. Fetching one document is `getAttachment`, one at a time, on
 * purpose.
 */
export async function listAttachments(opts: {
  orgId: string;
  subjectType: SubjectType | string;
  subjectId: string;
}): Promise<AttachmentMeta[]> {
  return prisma.attachment.findMany({
    where: { orgId: opts.orgId, subjectType: opts.subjectType, subjectId: opts.subjectId },
    select: META_SELECT,
    orderBy: { uploadedAt: "asc" },
  });
}

export interface FetchedAttachment extends AttachmentMeta {
  contentBase64: string;
  /**
   * Whether the stored bytes still hash to the stored SHA-256.
   *
   * This is the one thing this module exists to detect. Storing a hash that is
   * never checked proves nothing: the check has to happen on the way out, on
   * the copy actually being handed to whoever asked for it. A false here means
   * the row was altered by something other than this code — the document is no
   * longer the document that was approved, and the entry it supports can no
   * longer be relied on.
   */
  verified: boolean;
  /** Why verification failed, in a sentence, or null when it passed. */
  problem: string | null;
}

export async function getAttachment(opts: { orgId: string; id: string }): Promise<FetchedAttachment> {
  const row = await prisma.attachment.findFirst({
    where: { id: opts.id, orgId: opts.orgId },
  });
  if (!row) throw new LedgerError("That attachment does not exist.");

  const bytes = Buffer.from(row.content, "base64");
  const actual = createHash("sha256").update(bytes).digest("hex");

  let problem: string | null = null;
  if (actual !== row.sha256) {
    problem =
      `${row.filename} no longer matches the hash recorded when it was attached ` +
      `(stored bytes hash to ${actual}, the record says ${row.sha256}). ` +
      `Treat this document as unproven and find out who changed it.`;
  } else if (bytes.length !== row.sizeBytes) {
    // Belt and braces: a length that disagrees with the record is the same
    // class of fault and is cheap to notice while the bytes are already in hand.
    problem = `${row.filename} is ${bytes.length} bytes but the record says ${row.sizeBytes}.`;
  }

  const { content, ...meta } = row;
  return { ...meta, contentBase64: content, verified: problem === null, problem };
}

export interface RemovedAttachment extends AttachmentMeta {
  removedBy: string | null;
  removedAt: Date;
}

/**
 * Detach a document.
 *
 * Removal is allowed — a receipt attached to the wrong bill has to be
 * removable, and refusing would only produce a system where every record
 * carries somebody else's evidence. But it is an act worth a record, and there
 * is no attachment history table here, so what was removed is returned in full
 * (filename, hash, who uploaded it) for the caller to log. That is an honest
 * limitation stated out loud rather than a pretence that deletion is invisible.
 */
export async function removeAttachment(opts: {
  orgId: string;
  id: string;
  removedBy?: string;
}): Promise<RemovedAttachment> {
  const row = await prisma.attachment.findFirst({
    where: { id: opts.id, orgId: opts.orgId },
    select: META_SELECT,
  });
  if (!row) throw new LedgerError("That attachment does not exist.");

  await prisma.attachment.delete({ where: { id: row.id } });
  return { ...row, removedBy: opts.removedBy ?? null, removedAt: new Date() };
}

/**
 * How many documents each of these subjects carries.
 *
 * One grouped query rather than one per row: the audit trail shows an
 * attachment count against every entry on the page, and doing that a row at a
 * time is the shape of query that looks fine on a test fixture and falls over
 * on a real month.
 */
export async function attachmentCountsFor(opts: {
  orgId: string;
  subjectType: SubjectType | string;
  subjectIds: string[];
}): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (opts.subjectIds.length === 0) return out;

  const rows = await prisma.attachment.groupBy({
    by: ["subjectId"],
    where: { orgId: opts.orgId, subjectType: opts.subjectType, subjectId: { in: opts.subjectIds } },
    _count: { _all: true },
  });
  for (const r of rows) out.set(r.subjectId, r._count._all);
  return out;
}

/* ------------------------------------------------------------------ helpers */

/**
 * Base64 in, bytes out, with the two shapes a browser actually sends handled:
 * a `data:` URL from FileReader.readAsDataURL, and line-wrapped MIME base64.
 * Both are stripped before decoding so that the same file always produces the
 * same hash — whitespace surviving into the column would make two identical
 * documents look different and defeat deduplication.
 */
function decodeBase64(raw: string, filename: string): Buffer {
  const withoutPrefix = raw.replace(/^data:[^;,]*;base64,/i, "");
  const compact = withoutPrefix.replace(/\s+/g, "");
  if (compact === "") return Buffer.alloc(0);

  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) {
    throw new LedgerError(`${filename} was not sent as base64, so there is nothing to store.`);
  }
  const bytes = Buffer.from(compact, "base64");
  // Buffer.from ignores what it cannot decode instead of complaining, so the
  // only way to know the whole string was read is to encode it back.
  if (bytes.toString("base64").replace(/=+$/, "") !== compact.replace(/=+$/, "")) {
    throw new LedgerError(`${filename} is not valid base64 — some of it could not be decoded.`);
  }
  return bytes;
}

/** One decimal place, which is all anyone needs to see how far over they are. */
function mb(bytes: number): string {
  return (Math.round((bytes / (1024 * 1024)) * 10) / 10).toString();
}

/** Thousands separators, so a byte count can be read at a glance. */
function group(n: number): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
