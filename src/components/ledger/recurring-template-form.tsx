"use client";

import * as React from "react";
import { Figure, Panel } from "./primitives";
import { fmtMinor, parseAmount, toInput } from "@/lib/ledger/format";

/**
 * The form a standing instruction is written on — the same one whether it is
 * being created or corrected.
 *
 * It is one component rather than two because the rules are one set of rules: a
 * template that cannot balance, or that would end before it starts, or that
 * reverses a prepayment release, is refused on the way in and has to be refused
 * on the way back in as well. `updateTemplate` re-validates everything on every
 * save for the same reason — a template is only ever stored in a state that can
 * actually post — and a second, looser edit form would be a way round that.
 *
 * The lines are checked before the request goes out, but the server is the
 * authority: it is the one that knows whether 1100 is a control account and
 * whether 6100 exists in this entity's chart at all.
 */

/** A line as the API carries it: minor units, written as digits. */
export interface TemplateLineWire {
  account: string;
  debit?: string;
  credit?: string;
  memo?: string;
}

/** What create takes, and what an update patch is made of. */
export interface TemplateWire {
  code: string;
  name: string;
  frequency: string;
  kind: string;
  startsOn: string;
  endsOn?: string | null;
  autoReverse?: boolean;
  lines: TemplateLineWire[];
}

/** The template being corrected, as the status read carries it. */
export interface ExistingTemplate {
  code: string;
  name: string;
  kind: string;
  frequency: string;
  startsOn: string;
  endsOn: string | null;
  autoReverse: boolean;
  /** Null when the saved lines cannot be read — which is what `problem` says. */
  lines: TemplateLineWire[] | null;
  problem: string | null;
}

/**
 * The currency the template arithmetic works in.
 *
 * A recurring journal posts in the book's own currency, and no read publishes
 * that to the browser — the same assumption `BOOK_CURRENCY` states in
 * ar-posting.tsx, kept in one place here rather than defaulted silently in four
 * calls to the parser.
 */
const BOOK_CURRENCY = "AED";

interface DraftLine { account: string; side: "debit" | "credit"; amount: string; memo: string }

const BLANK: DraftLine = { account: "", side: "debit", amount: "", memo: "" };

/** A stored line back into something somebody can edit. */
function draftOf(line: TemplateLineWire): DraftLine {
  const debit = line.debit !== undefined && line.debit !== null && line.debit !== "";
  return {
    account: line.account,
    side: debit ? "debit" : "credit",
    amount: toInput(debit ? line.debit : line.credit, BOOK_CURRENCY),
    memo: line.memo ?? "",
  };
}

export function TemplateForm({
  existing,
  busy,
  onSave,
  onCancel,
}: {
  /** Absent for a new template. */
  existing?: ExistingTemplate | null;
  busy: boolean;
  onSave: (t: TemplateWire) => void;
  onCancel?: () => void;
}) {
  const [f, setF] = React.useState({
    code: existing?.code ?? "",
    name: existing?.name ?? "",
    frequency: existing?.frequency ?? "MONTHLY",
    kind: existing?.kind ?? "STANDING",
    startsOn: existing?.startsOn ?? new Date().toISOString().slice(0, 10),
    endsOn: existing?.endsOn ?? "",
  });
  const [autoReverseTouched, setTouched] = React.useState(false);
  const [autoReverse, setAutoReverse] = React.useState(existing?.autoReverse ?? false);
  const [lines, setLines] = React.useState<DraftLine[]>(
    existing?.lines?.length ? existing.lines.map(draftOf) : [{ ...BLANK }, { ...BLANK, side: "credit" }],
  );

  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));
  const setLine = (i: number, patch: Partial<DraftLine>) =>
    setLines((ls) => ls.map((l, j) => (i === j ? { ...l, ...patch } : l)));

  /*
   * An accrual reverses unless someone says otherwise; a prepayment release
   * never does, because it is the release itself. On a template already saved
   * the answer is whatever it was saved with — until the kind is changed, at
   * which point it is re-derived from the new kind, which is exactly what
   * `resolveAutoReverse` does server-side with an absent flag.
   */
  const kindKept = existing !== null && existing !== undefined && f.kind === existing.kind;
  const reverses = autoReverseTouched
    ? autoReverse
    : kindKept && existing
      ? existing.autoReverse
      : f.kind === "ACCRUAL";

  const parsed = lines.map((l) => ({ ...l, minor: parseAmount(l.amount, BOOK_CURRENCY) }));
  const debits = parsed.reduce((a, l) => a + (l.side === "debit" && l.minor ? l.minor : 0n), 0n);
  const credits = parsed.reduce((a, l) => a + (l.side === "credit" && l.minor ? l.minor : 0n), 0n);
  const filled = parsed.filter((l) => l.account.trim() && l.minor && l.minor > 0n);
  const out = debits - credits;

  const blocker =
    !f.code.trim() ? "Give the template a code." :
    !f.name.trim() ? "Give the template a name." :
    filled.length < 2 ? "A template needs at least two lines — one line cannot balance." :
    filled.length !== parsed.length ? "Every line needs an account and an amount." :
    out !== 0n
      ? `It does not balance — out by ${fmtMinor(out < 0n ? -out : out, BOOK_CURRENCY, { zero: "zero" })} on the ` +
        `${out > 0n ? "debit" : "credit"} side.`
    : f.kind === "PREPAYMENT" && reverses
      ? "A prepayment release is not reversed. Turn reversal off, or make this an accrual."
    : f.endsOn && f.endsOn < f.startsOn ? "It would end before it starts." :
    null;

  const body = (
    <>
      <div className="sw-label">{existing ? `Edit template ${existing.code}` : "New recurring template"}</div>
      <p className="sw-sub mt-1 max-w-[70ch]">
        {existing
          ? "Editing changes what it posts from here on. The journals it has already posted still say what they " +
            "said on the day — a template is the instruction, not the entry."
          : "The lines are checked now rather than at run time. A template that would fail every month at midnight " +
            "is worse than one that refuses to be saved."}
      </p>
      {existing?.problem && (
        <p className="sw-error mt-2" role="alert" data-testid={`template-problem-${existing.code}`}>
          {existing.problem} Its lines could not be loaded into this form, so they have to be written out again.
        </p>
      )}

      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Code">
          <input className="sw-input" value={f.code} onChange={(e) => set("code", e.target.value)} placeholder="RENT" />
        </Field>
        <Field label="Name">
          <input className="sw-input" value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="Office rent" />
        </Field>
        <Field label="Kind">
          <select className="sw-select" value={f.kind} onChange={(e) => { set("kind", e.target.value); setTouched(false); }}>
            <option value="STANDING">Standing charge</option>
            <option value="ACCRUAL">Accrual</option>
            <option value="PREPAYMENT">Prepayment release</option>
          </select>
        </Field>
        <Field label="Frequency">
          <select className="sw-select" value={f.frequency} onChange={(e) => set("frequency", e.target.value)}>
            <option value="MONTHLY">Monthly</option>
            <option value="QUARTERLY">Quarterly</option>
            <option value="ANNUAL">Annual</option>
          </select>
        </Field>
        <Field label="Starts">
          <input type="date" className="sw-input" value={f.startsOn} onChange={(e) => set("startsOn", e.target.value)} />
        </Field>
        <Field label="Ends (optional)">
          <input
            type="date"
            className="sw-input"
            value={f.endsOn}
            onChange={(e) => set("endsOn", e.target.value)}
            data-testid="template-ends-on"
          />
        </Field>
        <label className="flex items-end gap-2 pb-1">
          <input
            type="checkbox"
            checked={reverses}
            onChange={(e) => { setTouched(true); setAutoReverse(e.target.checked); }}
            data-testid="auto-reverse"
          />
          <span className="sw-sub">Reverse on the first of the next period</span>
        </label>
      </div>

      <div className="sw-label mt-4">Lines</div>
      <div className="mt-2 space-y-2">
        {lines.map((l, i) => (
          <div key={i} className="grid gap-2 sm:grid-cols-[7rem_7rem_var(--sw-col-amount)_1fr]">
            <input className="sw-input" value={l.account} onChange={(e) => setLine(i, { account: e.target.value })} placeholder="6100" aria-label={`Account for line ${i + 1}`} />
            <select className="sw-select" value={l.side} onChange={(e) => setLine(i, { side: e.target.value as DraftLine["side"] })} aria-label={`Side for line ${i + 1}`}>
              <option value="debit">Debit</option>
              <option value="credit">Credit</option>
            </select>
            <input className="sw-input sw-cell-num" inputMode="decimal" value={l.amount} onChange={(e) => setLine(i, { amount: e.target.value })} placeholder="15,000.00" aria-label={`Amount for line ${i + 1}`} />
            <input className="sw-input" value={l.memo} onChange={(e) => setLine(i, { memo: e.target.value })} placeholder="Memo (optional)" aria-label={`Memo for line ${i + 1}`} />
          </div>
        ))}
      </div>
      <button type="button" className="sw-btn mt-2" onClick={() => setLines((ls) => [...ls, { ...BLANK }])}>
        Add line
      </button>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="sw-btn sw-btn-primary"
          aria-disabled={blocker !== null || busy || undefined}
          disabled={blocker !== null || busy}
          data-testid={existing ? `save-template-${existing.code}` : "save-template"}
          onClick={() => onSave({
            code: f.code.trim(), name: f.name.trim(), frequency: f.frequency, kind: f.kind,
            startsOn: f.startsOn,
            // Null rather than absent on an edit: absent keeps the end date it
            // has, and clearing the box is somebody saying it has none.
            ...(f.endsOn ? { endsOn: f.endsOn } : existing ? { endsOn: null } : {}),
            autoReverse: reverses,
            lines: parsed.map((l) => ({
              account: l.account.trim(),
              ...(l.side === "debit" ? { debit: (l.minor as bigint).toString() } : { credit: (l.minor as bigint).toString() }),
              ...(l.memo.trim() ? { memo: l.memo.trim() } : {}),
            })),
          })}
        >
          {busy ? "Saving…" : existing ? "Save changes" : "Save template"}
        </button>
        {onCancel && (
          <button type="button" className="sw-btn" onClick={onCancel}>Cancel</button>
        )}
        {blocker && <span className="sw-sub" role="status" data-testid="template-blocker">{blocker}</span>}
        {!blocker && (
          <span className="sw-sub">
            <Figure minor={debits} colour={false} /> each {f.frequency.toLowerCase().replace("ly", "")} period
            {reverses && ", released on the first of the next"}.
          </span>
        )}
      </div>
    </>
  );

  // Inside a row the panel would be a card inside a card; standing on its own
  // above the table it is the card.
  return existing ? <>{body}</> : <Panel className="mb-4 p-4">{body}</Panel>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="sw-label">{label}</span>
      <span className="mt-1 block">{children}</span>
    </label>
  );
}
