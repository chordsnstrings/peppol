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

  const onCellKey = (e: React.KeyboardEvent<HTMLInputElement>, key: number, field: keyof Row) => {
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

  return (
    <div className="space-y-4">
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
                      />
                    </td>
                    <td>
                      <input
                        className="sw-cell sw-cell-num"
                        inputMode="decimal"
                        aria-label={`Line ${i + 1} debit`}
                        placeholder={dSug}
                        value={r.debit}
                        onChange={(e) => setRow(r.key, { debit: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === "Tab" && !e.shiftKey && dSug && !r.debit) { setRow(r.key, { debit: dSug }); }
                          onCellKey(e, r.key, "debit");
                        }}
                        onBlur={(e) => commitAmount(r.key, "debit", e.target.value)}
                        style={parseAmount(r.debit, CURRENCY) === null ? { boxShadow: "inset 0 -2px 0 var(--sw-neg)" } : undefined}
                      />
                    </td>
                    <td>
                      <input
                        className="sw-cell sw-cell-num"
                        inputMode="decimal"
                        aria-label={`Line ${i + 1} credit`}
                        placeholder={cSug}
                        value={r.credit}
                        onChange={(e) => setRow(r.key, { credit: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === "Tab" && !e.shiftKey && cSug && !r.credit) { setRow(r.key, { credit: cSug }); }
                          onCellKey(e, r.key, "credit");
                        }}
                        onBlur={(e) => commitAmount(r.key, "credit", e.target.value)}
                        style={parseAmount(r.credit, CURRENCY) === null ? { boxShadow: "inset 0 -2px 0 var(--sw-neg)" } : undefined}
                      />
                    </td>
                    <td>
                      <button
                        type="button"
                        className="w-full px-2 text-[1rem] leading-none"
                        style={{ color: "var(--sw-fg-faint)" }}
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
                <td colSpan={3} style={{ textAlign: "end" }}>Totals</td>
                <td className="sw-num" data-testid="total-debit">{fmtMinor(totalDebit, CURRENCY, { zero: "zero" })}</td>
                <td className="sw-num" data-testid="total-credit">{fmtMinor(totalCredit, CURRENCY, { zero: "zero" })}</td>
                <td />
              </tr>
              {difference !== 0n && (
                <tr>
                  {/* The difference sits under the column it is missing from. */}
                  <td colSpan={3} style={{ textAlign: "end", fontWeight: 400, color: "var(--sw-fg-muted)" }}>
                    Out of balance
                  </td>
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
          <span id="je-blocker" className="sw-sub" role="status" aria-live="polite" data-testid="blocker">
            {blocker}
          </span>
        )}
        {!blocker && !posting && (
          <span className="sw-sub" role="status" aria-live="polite">
            Balanced at {fmtMinor(totalDebit, CURRENCY, { zero: "zero" })} — ready to post.
          </span>
        )}
      </div>

      <p className="sw-sub">
        Amount cells take arithmetic: <code>1200/3</code>, <code>(450+80)*1.05</code>. A minus typed
        into Debit moves itself to Credit. <kbd>Ctrl</kbd>+<kbd>D</kbd> copies the cell above.
      </p>
    </div>
  );
}
