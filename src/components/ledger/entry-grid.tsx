"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { api, ApiError, useEntityId, useLedgerQuery } from "./use-ledger";
import { ErrorNote, Panel } from "./primitives";
import { fmtMinor, parseAmount, toInput } from "@/lib/ledger/format";

interface Account { id: string; code: string; name: string; nameAr: string | null; isPostable: boolean; isControl: boolean; currency: string | null; status: string }
interface Period { id: string; label: string; status: string; startsOn: string; endsOn: string }

interface Row {
  key: number;
  /** What the user typed into the account cell, matched against code and name. */
  account: string;
  debit: string;
  credit: string;
  memo: string;
}

const CURRENCY = "AED";
/** The editable columns, in grid order. `keyof Row` would drag in the numeric
 *  `key` and make every assignment narrow to never. */
type TextCol = "account" | "memo" | "debit" | "credit";

/** Strip whatever a spreadsheet decorated the figure with — currency symbols,
 *  non-breaking spaces — before the amount parser sees it. */
function sanitiseAmount(v: string): string {
  return v.replace(/\u00a0/g, " ").replace(/[^\d+\-*/(). ,]/g, "").trim();
}

let nextKey = 1;
const blank = (): Row => ({ key: nextKey++, account: "", debit: "", credit: "", memo: "" });

/**
 * The journal entry grid.
 *
 * The rules that shape this are not cosmetic — each one comes from a way that
 * data-entry screens waste a bookkeeper's day:
 *
 *  - The out-of-balance difference is shown UNDER the column it is missing
 *    from, not in a corner. "Debits are short by 250.00" is a correction; a
 *    banner saying "does not balance" is a puzzle.
 *  - The last empty amount cell offers the balancing figure. Accepting it is
 *    one keystroke; ignoring it costs nothing.
 *  - The Post button is never silently dead. It stays focusable and carries the
 *    exact reason it cannot fire, so a keyboard user hears the reason instead
 *    of finding a control that does nothing.
 *  - The difference stays neutral ink while you are typing. An entry mid-keying
 *    is *supposed* to be unbalanced; colouring it red punishes normal work. It
 *    turns red only after a post has been attempted.
 *  - A minus typed into Debit moves itself to Credit, because that is what the
 *    person meant.
 */
export function EntryGrid() {
  const router = useRouter();
  const entityId = useEntityId();
  const [rows, setRows] = React.useState<Row[]>(() => [blank(), blank()]);
  const [entryDate, setEntryDate] = React.useState(() => new Date().toISOString().slice(0, 10));
  const [memo, setMemo] = React.useState("");
  const [attempted, setAttempted] = React.useState(false);
  const [posting, setPosting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [pasteNote, setPasteNote] = React.useState<string | null>(null);

  const accountsQ = useLedgerQuery<{ accounts: Account[] }>(
    entityId ? `/api/ledger/accounts?entityId=${entityId}&postable=1` : null,
  );
  const periodsQ = useLedgerQuery<{ periods: Period[] }>(
    entityId ? `/api/ledger/periods?entityId=${entityId}` : null,
  );
  const accounts = accountsQ.data?.accounts ?? [];

  /** Resolve a typed cell to exactly one account, or nothing. */
  const resolve = React.useCallback(
    (text: string): Account | undefined => {
      const t = text.trim().toLowerCase();
      if (!t) return undefined;
      const exact = accounts.find((a) => a.code.toLowerCase() === t);
      if (exact) return exact;
      const hits = accounts.filter(
        (a) => a.code.toLowerCase().startsWith(t) || a.name.toLowerCase().includes(t),
      );
      return hits.length === 1 ? hits[0] : undefined;
    },
    [accounts],
  );

  const parsed = rows.map((r) => {
    const account = resolve(r.account);
    const debit = parseAmount(r.debit, CURRENCY);
    const credit = parseAmount(r.credit, CURRENCY);
    return { row: r, account, debit, credit, bad: debit === null || credit === null };
  });

  const totalDebit = parsed.reduce((a, p) => a + (p.debit ?? 0n), 0n);
  const totalCredit = parsed.reduce((a, p) => a + (p.credit ?? 0n), 0n);
  const difference = totalDebit - totalCredit;
  const filled = parsed.filter((p) => (p.debit ?? 0n) !== 0n || (p.credit ?? 0n) !== 0n);

  const periodFor = (date: string) =>
    (periodsQ.data?.periods ?? []).find((p) => date >= p.startsOn.slice(0, 10) && date <= p.endsOn.slice(0, 10));
  const period = periodFor(entryDate);

  /** Exactly why Post cannot fire — shown, not hidden behind a disabled button. */
  const blocker: string | null = (() => {
    if (!entityId) return "Choose an entity first.";
    if (parsed.some((p) => p.bad)) return "One of the amounts is not a number.";
    // Once anything is keyed, the difference is the more useful message: it
    // names the amount to type next, which is also how the second line appears.
    if (filled.length === 1 && difference !== 0n) {
      const side = difference > 0n ? "Credits" : "Debits";
      return `${side} are short by ${fmtMinor(difference < 0n ? -difference : difference, CURRENCY, { zero: "zero" })}.`;
    }
    if (filled.length < 2) return "A journal needs at least two lines with an amount.";
    if (filled.some((p) => !p.account)) return "Every line with an amount needs an account.";
    const dup = filled.find((p) => (p.debit ?? 0n) !== 0n && (p.credit ?? 0n) !== 0n);
    if (dup) return "A line is either a debit or a credit, not both.";
    const ctl = filled.find((p) => p.account?.isControl);
    if (ctl) return `${ctl.account!.code} ${ctl.account!.name} is a control account — it is fed by its subledger and refuses a manual journal.`;
    if (!period) return `There is no accounting period covering ${entryDate}.`;
    if (period.status !== "open") return `${period.label} is ${period.status.replace(/_/g, " ")}. Post into an open period instead.`;
    if (difference !== 0n) {
      const short = difference > 0n ? "Credits" : "Debits";
      return `${short} are short by ${fmtMinor(difference < 0n ? -difference : difference, CURRENCY, { zero: "zero" })}.`;
    }
    return null;
  })();

  const setRow = (key: number, patch: Partial<Row>) =>
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  /**
   * A minus in Debit belongs in Credit. Rather than reject it, move it — the
   * user told us which side they meant, just on the wrong column.
   */
  const commitAmount = (key: number, side: "debit" | "credit", text: string) => {
    const v = parseAmount(text, CURRENCY);
    // Not a number: leave the text exactly as typed so it can be corrected,
    // rather than wiping the cell and making the user retype it.
    if (v === null) return;
    const other = side === "debit" ? "credit" : "debit";
    if (v < 0n) {
      setRow(key, { [side]: "", [other]: toInput(-v, CURRENCY) } as Partial<Row>);
    } else if (v === 0n) {
      setRow(key, { [side]: "" } as Partial<Row>);
    } else {
      // One side per line: entering an amount clears the opposite column.
      setRow(key, { [side]: toInput(v, CURRENCY), [other]: "" } as Partial<Row>);
    }
  };

  /** Offer the balancing figure on the last empty amount cell. */
  const suggestion = (key: number, side: "debit" | "credit"): string | undefined => {
    if (difference === 0n) return undefined;
    // Only the first empty line offers it — a suggestion repeated down five
    // blank rows reads as five different amounts.
    const firstEmpty = parsed.findIndex((p) => (p.debit ?? 0n) === 0n && (p.credit ?? 0n) === 0n);
    if (firstEmpty < 0 || rows[firstEmpty].key !== key) return undefined;
    if (difference > 0n && side === "credit") return toInput(difference, CURRENCY);
    if (difference < 0n && side === "debit") return toInput(-difference, CURRENCY);
    return undefined;
  };

  /**
   * Paste from a spreadsheet.
   *
   * This is not a nicety — a month-end accrual schedule lives in Excel, and
   * the alternative to pasting it is retyping it, which is where transcription
   * errors come from. Both Excel and Google Sheets put TSV on the clipboard.
   *
   * Rules that keep it honest:
   *  - the paste anchors at the cell that has focus and expands right and down,
   *    creating rows as needed. It never wraps into the next row.
   *  - every pasted amount goes through the same parser as typed input, so
   *    "1,200.00", "(450)" and a trailing-minus export all land correctly.
   *  - nothing is posted. The grid fills in and the normal blocking rules
   *    apply, so a paste that does not balance is as visible as one typed.
   */
  const onPaste = (e: React.ClipboardEvent<HTMLInputElement>, key: number, field: TextCol) => {
    const text = e.clipboardData.getData("text/plain");
    if (!text || !/[\t\r\n]/.test(text)) return; // a single value: let the browser handle it
    e.preventDefault();

    const matrix = text
      .replace(/\r\n?/g, "\n")
      .replace(/\n$/, "")
      .split("\n")
      .map((line) => line.split("\t"));

    const COLS: TextCol[] = ["account", "memo", "debit", "credit"];
    const startCol = Math.max(0, COLS.indexOf(field));

    setRows((rs) => {
      const startRow = rs.findIndex((r) => r.key === key);
      const next = [...rs];
      matrix.forEach((cells, dy) => {
        const idx = startRow + dy;
        while (next.length <= idx) next.push(blank());
        const row = { ...next[idx] };
        // Land every cell first. Deciding the debit/credit side inside the
        // loop lets a trailing empty column overwrite a figure that was just
        // moved across — spreadsheet rows very often end in an empty cell.
        const touched = new Set<TextCol>();
        cells.forEach((raw, dx) => {
          const col = COLS[startCol + dx];
          if (!col) return; // truncate at the last column rather than wrapping
          row[col] = raw.trim();
          touched.add(col);
        });

        if (touched.has("debit") || touched.has("credit")) {
          const d = parseAmount(sanitiseAmount(row.debit), CURRENCY);
          const c = parseAmount(sanitiseAmount(row.credit), CURRENCY);
          // A negative on either side means the other side, same as typing one.
          let debit = d ?? 0n;
          let credit = c ?? 0n;
          if (debit < 0n) { credit += -debit; debit = 0n; }
          if (credit < 0n) { debit += -credit; credit = 0n; }
          row.debit = d === null && row.debit ? row.debit : debit === 0n ? "" : toInput(debit, CURRENCY);
          row.credit = c === null && row.credit ? row.credit : credit === 0n ? "" : toInput(credit, CURRENCY);
        }
        next[idx] = row;
      });
      return next;
    });

    setPasteNote(`Pasted ${matrix.length} row${matrix.length === 1 ? "" : "s"}. Check the totals before posting.`);
  };

  const onCellKey = (e: React.KeyboardEvent<HTMLInputElement>, key: number, field: TextCol) => {
    // Ctrl+D copies the cell above — the single most repeated keystroke in
    // manual entry (same account, different amount).
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "d") {
      e.preventDefault();
      const idx = rows.findIndex((r) => r.key === key);
      if (idx > 0) setRow(key, { [field]: rows[idx - 1][field] } as Partial<Row>);
      return;
    }
    // Enter on the last row adds a line rather than submitting a half-typed entry.
    if (e.key === "Enter" && rows[rows.length - 1].key === key) {
      e.preventDefault();
      setRows((rs) => [...rs, blank()]);
    }
  };

  const submit = async () => {
    setAttempted(true);
    if (blocker || !entityId) return;
    setPosting(true);
    setError(null);
    try {
      const res = await api<{ entry: { id: string; series: string; number: number } }>("/api/ledger/journals", {
        method: "POST",
        body: JSON.stringify({
          entityId,
          entryDate,
          memo: memo.trim() || undefined,
          // Minor units go over the wire as strings, not numbers — a
          // consolidated group balance can exceed what a JSON number holds.
          lines: filled.map((p) => ({
            account: p.account!.code,
            debit: (p.debit ?? 0n) !== 0n ? (p.debit as bigint).toString() : undefined,
            credit: (p.credit ?? 0n) !== 0n ? (p.credit as bigint).toString() : undefined,
            memo: p.row.memo.trim() || undefined,
          })),
        }),
      });
      router.push(`/accounting/journals?posted=${res.entry.series}-${res.entry.number}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "The entry could not be posted.");
      setPosting(false);
    }
  };

  const diffTone = attempted && difference !== 0n ? "sw-num-neg" : "";

  /**
   * The balance state is the textbook case for WCAG 4.1.3 Status Messages: a
   * fact that must reach a screen-reader user without stealing focus.
   *
   * Three things make the difference between usable and maddening:
   *  - the region is mounted before it has content. A role="status" element
   *    injected together with its text announces nothing in most readers.
   *  - it is debounced, so typing "12000" is one announcement rather than five.
   *  - aria-atomic reads the whole sentence, so the user hears "out of balance
   *    by 250.00, debits are short" instead of a naked "250".
   */
  const [liveMessage, setLiveMessage] = React.useState("");
  const spoken = blocker
    ? blocker
    : `Balanced at ${fmtMinor(totalDebit, CURRENCY, { zero: "zero" })} across ${filled.length} lines. Ready to post.`;
  React.useEffect(() => {
    const t = setTimeout(() => setLiveMessage(spoken), 700);
    return () => clearTimeout(t);
  }, [spoken]);

  return (
    <div className="space-y-4">
      {/* Mounted unconditionally and left empty until there is something to
          say — see the note on liveMessage above. */}
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {liveMessage}
      </div>

      <Panel className="p-4">
        <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
          <div>
            <label className="sw-label block" htmlFor="je-date">Date</label>
            <input id="je-date" type="date" className="sw-input mt-1" value={entryDate} onChange={(e) => setEntryDate(e.target.value)} />
            <p className="sw-sub mt-1">
              {period ? `Period ${period.label} · ${period.status.replace(/_/g, " ")}` : "No period covers this date"}
            </p>
          </div>
          <div>
            <label className="sw-label block" htmlFor="je-memo">Description</label>
            <input
              id="je-memo"
              className="sw-input mt-1"
              placeholder="What this entry records — a reader in three years should not need to guess"
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
            />
          </div>
        </div>
      </Panel>

      <Panel className="overflow-hidden">
        <div className="sw-scroll">
          <table className="sw-table sw-grid">
            <caption className="sr-only">Journal entry lines — account, description, debit and credit</caption>
            <thead>
              <tr>
                <th style={{ width: "3rem" }}>#</th>
                <th style={{ minWidth: "18rem" }}>Account</th>
                <th style={{ minWidth: "12rem" }}>Line description</th>
                <th className="sw-col-debit sw-num" style={{ width: "var(--sw-col-amount)" }}>Debit</th>
                <th className="sw-col-credit sw-num" style={{ width: "var(--sw-col-amount)" }}>Credit</th>
                <th style={{ width: "2.5rem" }}><span className="sr-only">Remove</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const p = parsed[i];
                const dSug = suggestion(r.key, "debit");
                const cSug = suggestion(r.key, "credit");
                return (
                  <tr key={r.key}>
                    <td className="sw-code" style={{ paddingInlineStart: "0.625rem" }}>{i + 1}</td>
                    <td>
                      <input
                        className="sw-cell"
                        list="je-accounts"
                        placeholder="Code or name"
                        aria-label={`Line ${i + 1} account`}
                        value={r.account}
                        onChange={(e) => setRow(r.key, { account: e.target.value })}
                        onKeyDown={(e) => onCellKey(e, r.key, "account")}
                        onPaste={(e) => onPaste(e, r.key, "account")}
                        onBlur={() => { const a = resolve(r.account); if (a) setRow(r.key, { account: a.code }); }}
                      />
                      {p.account && (
                        <span className="block truncate px-2 pb-0.5 text-[0.6875rem]" style={{ color: "var(--sw-fg-muted)", marginTop: "-0.55rem" }}>
                          {p.account.name}
                        </span>
                      )}
                    </td>
                    <td>
                      <input
                        className="sw-cell"
                        aria-label={`Line ${i + 1} description`}
                        value={r.memo}
                        onChange={(e) => setRow(r.key, { memo: e.target.value })}
                        onKeyDown={(e) => onCellKey(e, r.key, "memo")}
                        onPaste={(e) => onPaste(e, r.key, "memo")}
                      />
                    </td>
                    <td>
                      <input
                        className={`sw-cell sw-cell-num${parseAmount(r.debit, CURRENCY) === null ? " sw-cell-invalid" : ""}`}
                        inputMode="decimal"
                        aria-invalid={parseAmount(r.debit, CURRENCY) === null || undefined}
                        aria-label={`Line ${i + 1} debit`}
                        placeholder={dSug}
                        value={r.debit}
                        onChange={(e) => setRow(r.key, { debit: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === "Tab" && !e.shiftKey && dSug && !r.debit) { setRow(r.key, { debit: dSug }); }
                          onCellKey(e, r.key, "debit");
                        }}
                        onPaste={(e) => onPaste(e, r.key, "debit")}
                        onBlur={(e) => commitAmount(r.key, "debit", e.target.value)}
                      />
                    </td>
                    <td>
                      <input
                        className={`sw-cell sw-cell-num${parseAmount(r.credit, CURRENCY) === null ? " sw-cell-invalid" : ""}`}
                        inputMode="decimal"
                        aria-invalid={parseAmount(r.credit, CURRENCY) === null || undefined}
                        aria-label={`Line ${i + 1} credit`}
                        placeholder={cSug}
                        value={r.credit}
                        onChange={(e) => setRow(r.key, { credit: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === "Tab" && !e.shiftKey && cSug && !r.credit) { setRow(r.key, { credit: cSug }); }
                          onCellKey(e, r.key, "credit");
                        }}
                        onPaste={(e) => onPaste(e, r.key, "credit")}
                        onBlur={(e) => commitAmount(r.key, "credit", e.target.value)}
                      />
                    </td>
                    <td>
                      <button
                        type="button"
                        className="sw-icon-btn"
                        aria-label={`Remove line ${i + 1}`}
                        onClick={() => setRows((rs) => (rs.length > 2 ? rs.filter((x) => x.key !== r.key) : rs.map((x) => (x.key === r.key ? blank() : x))))}
                      >
                        ×
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row" colSpan={3} style={{ textAlign: "end" }}>Totals</th>
                <td className="sw-num" data-testid="total-debit">{fmtMinor(totalDebit, CURRENCY, { zero: "zero" })}</td>
                <td className="sw-num" data-testid="total-credit">{fmtMinor(totalCredit, CURRENCY, { zero: "zero" })}</td>
                <td />
              </tr>
              {difference !== 0n && (
                <tr>
                  {/* The difference sits under the column it is missing from. */}
                  <th scope="row" colSpan={3} style={{ textAlign: "end", fontWeight: 400, color: "var(--sw-fg-muted)" }}>
                    Out of balance
                  </th>
                  <td className={`sw-num ${diffTone}`} data-testid="diff-debit">
                    {difference < 0n ? fmtMinor(-difference, CURRENCY, { zero: "zero" }) : ""}
                  </td>
                  <td className={`sw-num ${diffTone}`} data-testid="diff-credit">
                    {difference > 0n ? fmtMinor(difference, CURRENCY, { zero: "zero" }) : ""}
                  </td>
                  <td />
                </tr>
              )}
            </tfoot>
          </table>
        </div>
        <datalist id="je-accounts">
          {accounts.map((a) => (
            <option key={a.id} value={a.code}>{`${a.code} — ${a.name}`}</option>
          ))}
        </datalist>
      </Panel>

      {pasteNote && (
        <div className="sw-note" data-testid="paste-note">
          {pasteNote}{" "}
          <button type="button" className="sw-link" onClick={() => setPasteNote(null)}>Dismiss</button>
        </div>
      )}
      {error && <ErrorNote>{error}</ErrorNote>}

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="sw-btn" onClick={() => setRows((rs) => [...rs, blank()])}>
          Add line
        </button>
        <button
          type="button"
          className="sw-btn sw-btn-primary"
          onClick={submit}
          aria-disabled={blocker !== null || posting || undefined}
          aria-describedby={blocker ? "je-blocker" : undefined}
          data-testid="post-entry"
        >
          {posting ? "Posting…" : "Post entry"}
        </button>
        {/* Always rendered when blocked, never a dead button with no explanation. */}
        {blocker && (
          <span id="je-blocker" className="sw-sub" data-testid="blocker">
            {blocker}
          </span>
        )}
        {!blocker && !posting && (
          <span className="sw-sub">
            Balanced at {fmtMinor(totalDebit, CURRENCY, { zero: "zero" })} — ready to post.
          </span>
        )}
      </div>

      <p className="sw-sub">
        Amount cells take arithmetic: <code>1200/3</code>, <code>(450+80)*1.05</code>. A minus typed
        into Debit moves itself to Credit. <kbd>Ctrl</kbd>+<kbd>D</kbd> copies the cell above. Paste a block from Excel
        or Sheets straight into the grid — account, description, debit, credit.
      </p>
    </div>
  );
}
