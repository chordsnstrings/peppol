"use client";

import * as React from "react";
import { api, ApiError } from "./use-ledger";
import { ErrorNote } from "./primitives";
import { useAsk } from "./ask";

/**
 * The documents behind an accounting record — the bank's letter behind a
 * charge, the supplier PDF behind a bill, the receipt behind a claim.
 *
 * The server side of this has existed, tested and routed, with no upload, list,
 * view or download anywhere in the product. That mattered for one reason above
 * the rest: `getAttachment` re-hashes the stored bytes on the way out and
 * reports whether they still match the SHA-256 taken when the file was
 * attached. A receipt quietly swapped after approval is exactly what an audit
 * is looking for, and until something fetched a document that check could never
 * fire. So the verdict is shown here rather than swallowed, and a document that
 * fails it is not opened as though nothing had happened.
 *
 * Two things this deliberately does:
 *
 *  - the list is fetched only when the component is mounted, and the bytes only
 *    when somebody asks for one file. The API keeps those two reads apart
 *    because fifty receipts on one bill is fifty megabytes of base64 to draw a
 *    list of filenames; mounting this behind a toggle keeps that promise.
 *  - removal asks first, in the page, and says what will be logged. There is no
 *    attachment history table, so a removal is a one-way act.
 *
 * It needs an <AskProvider> above it, which the accounting layout provides.
 */

/** What the API hands back for each document. Metadata only — never content. */
export interface AttachmentRow {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  uploadedBy: string | null;
  uploadedAt: string;
}

/**
 * The types the server accepts, for the file picker's filter only.
 *
 * `attachments.ts` holds the allowlist that decides; this is a hint that saves
 * somebody choosing a file that will be refused. A hint that drifts costs
 * nothing — the refusal still names what is accepted.
 */
const ACCEPT = ".pdf,.jpg,.jpeg,.png,.webp,.csv,.txt,application/pdf,image/jpeg,image/png,image/webp,text/csv,text/plain";

/**
 * 5 MB, matching MAX_BYTES in `src/lib/server/ledger/attachments.ts`, which is
 * the authority. Checked here only so a 200 MB scan is refused before it is
 * base64-encoded in the browser and pushed over the wire to be refused there.
 */
const LIMIT_BYTES = 5 * 1024 * 1024;

/**
 * Some browsers hand back an empty type for a file chosen from disk, most often
 * for CSV and plain text. The server refuses a file "of no stated type", which
 * is a true statement and a useless one to the person holding the receipt, so
 * the obvious cases are filled in from the extension.
 */
const BY_EXTENSION: Record<string, string> = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  csv: "text/csv",
  txt: "text/plain",
};

function typeOf(file: File): string {
  if (file.type) return file.type;
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  return BY_EXTENSION[ext] ?? "";
}

/** Bytes as a person reads them. Not money, so not the money formatter. */
function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(Math.round((bytes / (1024 * 1024)) * 10) / 10).toString()} MB`;
}

/** The file, base64, exactly as the API's `contentBase64` wants it. */
function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error(`${file.name} could not be read from disk.`));
    reader.readAsDataURL(file);
  });
}

/** Hand the bytes to the browser, to open or to save. */
function deliver(doc: { filename: string; mimeType: string; contentBase64: string }, how: "view" | "download") {
  const raw = atob(doc.contentBase64.replace(/^data:[^;,]*;base64,/i, ""));
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes], { type: doc.mimeType }));

  if (how === "view") {
    window.open(url, "_blank", "noopener,noreferrer");
  } else {
    const a = document.createElement("a");
    a.href = url;
    a.download = doc.filename;
    a.click();
  }
  // Long enough for the tab or the save dialog to have taken the bytes.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

interface Fetched {
  id: string;
  filename: string;
  mimeType: string;
  contentBase64: string;
  verified: boolean;
  problem: string | null;
}

export function Attachments({
  subjectType,
  subjectId,
  entityId,
  title = "Documents",
  note,
}: {
  /** JOURNAL_ENTRY | INVOICE | BILL | EXPENSE_CLAIM | ASSET | BANK_LINE. */
  subjectType: string;
  subjectId: string;
  entityId?: string;
  title?: string;
  /** One line saying what evidence belongs here, where the screen knows. */
  note?: string;
}) {
  const ask = useAsk();
  const [rows, setRows] = React.useState<AttachmentRow[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [message, setMessage] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  /** The integrity verdict for each document somebody has actually fetched. */
  const [checked, setChecked] = React.useState<Record<string, { verified: boolean; problem: string | null }>>({});
  const fileRef = React.useRef<HTMLInputElement | null>(null);

  const listPath = `/api/ledger/attachments?subjectType=${encodeURIComponent(subjectType)}&subjectId=${encodeURIComponent(subjectId)}`;

  const load = React.useCallback(async () => {
    setError(null);
    try {
      const r = await api<{ attachments: AttachmentRow[] }>(listPath);
      setRows(r.attachments);
    } catch (e) {
      setRows([]);
      setError(e instanceof ApiError ? e.message : "The documents on this record could not be read.");
    }
  }, [listPath]);

  React.useEffect(() => { void load(); }, [load]);

  const upload = async (file: File) => {
    setBusy("upload");
    setError(null);
    setMessage(null);
    try {
      if (file.size > LIMIT_BYTES) {
        throw new ApiError(
          `${file.name} is ${size(file.size)} and the limit is ${size(LIMIT_BYTES)}. Attachments are stored inside ` +
            `the ledger database, so a large scan belongs in a document store with a link to it here.`,
          413,
        );
      }
      const contentBase64 = await readAsDataUrl(file);
      const r = await api<{ attachment: AttachmentRow & { deduplicated: boolean } }>("/api/ledger/attachments", {
        method: "POST",
        body: JSON.stringify({
          entityId,
          subjectType,
          subjectId,
          filename: file.name,
          mimeType: typeOf(file),
          contentBase64,
        }),
      });
      setMessage(
        r.attachment.deduplicated
          ? `${r.attachment.filename} is already attached to this record — the same bytes, so nothing was added.`
          : `Attached ${r.attachment.filename}.`,
      );
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That file could not be attached.");
    } finally {
      setBusy(null);
      // So the same file can be chosen again after a refusal has been fixed.
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  /**
   * Fetch one document and check it before doing anything with it.
   *
   * `verified` is computed by re-hashing the bytes being handed over, so it is
   * a statement about this copy rather than about the row. A false is not a
   * display problem: the document is no longer the document that was approved,
   * and opening it as though it were would hide the one thing this module was
   * built to catch. So it is not opened — the sentence is shown, and the bytes
   * stay available to download deliberately, because whoever investigates needs
   * to see what is actually stored.
   */
  const fetchDoc = async (row: AttachmentRow, how: "view" | "download", force = false) => {
    setBusy(row.id);
    setError(null);
    setMessage(null);
    try {
      const r = await api<{ attachment: Fetched }>(`/api/ledger/attachments?id=${encodeURIComponent(row.id)}`);
      const doc = r.attachment;
      setChecked((c) => ({ ...c, [row.id]: { verified: doc.verified, problem: doc.problem } }));
      if (!doc.verified && !force) {
        setError(doc.problem ?? `${row.filename} could not be verified against the hash recorded when it was attached.`);
        return;
      }
      deliver(doc, how);
      if (!doc.verified) {
        setMessage(`${row.filename} was downloaded unverified. Treat it as evidence of what is stored, not as the approved document.`);
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : `${row.filename} could not be fetched.`);
    } finally {
      setBusy(null);
    }
  };

  const remove = async (row: AttachmentRow) => {
    const answer = await ask({
      title: `Detach ${row.filename}?`,
      detail:
        "The document is deleted, not archived — there is no attachment history here. What was removed is written " +
        "to the server log with its hash and the person who uploaded it, and that is the whole record of it.",
      confirmLabel: "Detach",
      destructive: true,
    });
    if (answer === null) return;

    setBusy(row.id);
    setError(null);
    setMessage(null);
    try {
      await api(`/api/ledger/attachments?id=${encodeURIComponent(row.id)}`, { method: "DELETE" });
      setMessage(`Detached ${row.filename}.`);
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : `${row.filename} could not be detached.`);
    } finally {
      setBusy(null);
    }
  };

  const inputId = `attach-${subjectType}-${subjectId}`;

  return (
    <div className="p-3" data-testid="attachments">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="sw-label">{title}</span>
        <span className="flex items-center gap-2">
          <label className="sw-label" htmlFor={inputId}>Attach a document</label>
          <input
            ref={fileRef}
            id={inputId}
            type="file"
            className="sw-input"
            style={{ width: "18rem" }}
            accept={ACCEPT}
            disabled={busy === "upload"}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }}
          />
        </span>
      </div>

      {note && <p className="sw-sub mt-1 max-w-[70ch]">{note}</p>}
      {error && <div className="mt-2"><ErrorNote>{error}</ErrorNote></div>}
      {message && <div className="sw-note mt-2" role="status" data-testid="attachment-result">{message}</div>}

      {rows === null ? (
        <p className="sw-sub mt-2" role="status">Reading the documents on this record…</p>
      ) : rows.length === 0 ? (
        <p className="sw-sub mt-2">
          Nothing is attached. An entry says what was decided; the document is the evidence it was decided on.
        </p>
      ) : (
        <div className="sw-scroll mt-2">
          <table className="sw-table">
            <caption className="sr-only">Documents attached to this record</caption>
            <thead>
              <tr>
                <th style={{ minWidth: "14rem" }}>File</th>
                <th style={{ width: "6rem" }}>Type</th>
                <th className="sw-num" style={{ width: "6rem" }}>Size</th>
                <th style={{ width: "7rem" }}>Attached</th>
                <th style={{ width: "10rem" }}>Hash</th>
                <th style={{ width: "14rem" }}><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const verdict = checked[row.id];
                return (
                  <tr key={row.id}>
                    <td className="max-w-0 truncate" title={row.filename}>{row.filename}</td>
                    <td className="sw-sub">{row.mimeType}</td>
                    <td className="sw-num">{size(row.sizeBytes)}</td>
                    <td>{row.uploadedAt.slice(0, 10)}</td>
                    <td>
                      {/* The hash is the whole point of the record; the first
                          twelve characters are enough to compare by eye, and
                          the title carries all of it. */}
                      <span
                        className="sw-code"
                        style={{ fontFamily: "var(--sw-font-mono)", fontSize: "0.6875rem" }}
                        title={row.sha256}
                      >
                        {row.sha256.slice(0, 12)}…
                      </span>
                      {verdict && (
                        <span className={`sw-chip ms-2 ${verdict.verified ? "sw-chip-ok" : "sw-chip-bad"}`}>
                          {verdict.verified ? "verified" : "unproven"}
                        </span>
                      )}
                    </td>
                    <td>
                      <span className="flex flex-wrap items-center gap-1 py-1">
                        <button
                          type="button"
                          className="sw-btn sw-btn-sm"
                          disabled={busy === row.id}
                          aria-disabled={busy === row.id || undefined}
                          onClick={() => void fetchDoc(row, "view")}
                        >
                          <span aria-hidden="true">View</span>
                          <span className="sr-only">{`View ${row.filename}`}</span>
                        </button>
                        <button
                          type="button"
                          className="sw-btn sw-btn-sm"
                          disabled={busy === row.id}
                          aria-disabled={busy === row.id || undefined}
                          onClick={() => void fetchDoc(row, "download", verdict?.verified === false)}
                        >
                          <span aria-hidden="true">{verdict?.verified === false ? "Download anyway" : "Download"}</span>
                          <span className="sr-only">{`Download ${row.filename}`}</span>
                        </button>
                        <button
                          type="button"
                          className="sw-icon-btn"
                          disabled={busy === row.id}
                          aria-label={`Detach ${row.filename}`}
                          onClick={() => void remove(row)}
                        >
                          ×
                        </button>
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="sw-sub mt-2 max-w-[75ch]">
        Every document is stored with the SHA-256 of its bytes, and fetching one re-hashes what is actually in the
        column. A document only shows as verified once somebody has opened it and that check has passed — the record
        alone proves nothing.
      </p>
    </div>
  );
}
