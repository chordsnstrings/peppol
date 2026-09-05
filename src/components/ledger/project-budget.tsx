"use client";

import * as React from "react";
import { Figure } from "./primitives";
import { parseAmount, toInput } from "@/lib/ledger/format";

/**
 * Revising what a job was quoted at.
 *
 * A budget that cannot be changed is a budget that stops being used. Scope
 * moves, a variation is agreed, a rate is renegotiated — and if the figure on
 * the screen still says what was quoted in March, every percentage drawn
 * against it is measuring the job against a price nobody is working to. The
 * usual answer is a spreadsheet beside the ledger, which is how job costing
 * quietly stops being job costing.
 *
 * `updateProject` has always accepted a new budget. What was missing is this:
 * somewhere to type it, and the figure it replaces printed beside it, because a
 * revision nobody can see the original of is not a revision — it is a quiet
 * edit, and the consumed percentage jumps overnight with nothing to explain it.
 *
 * The honest limit, stated here and in the panel itself: a project row carries
 * ONE budget. There is no history table behind it, so once this is saved the
 * figure on the left of the comparison is not held anywhere. This panel is the
 * last place both numbers appear together, which is exactly why it prints both,
 * and why the message it hands back names both as well.
 */

/** Truncated toward zero, as projects.ts does, so a share is never overstated. */
function consumedBps(spent: bigint, budget: bigint): bigint | null {
  return budget === 0n ? null : (spent * 10_000n) / budget;
}

const pct = (bps: bigint | null) => (bps === null ? "no budget" : `${(Number(bps) / 100).toFixed(2)}%`);

export function ProjectBudgetRevision({ project, busy, onCancel, onRevise }: {
  project: {
    code: string;
    name: string;
    currency: string;
    /** What the job is quoted at now — the figure about to be replaced. */
    budgetMinor: string;
    /** Cost tagged to the job. Exactly the report's own "spent". */
    spentMinor: string;
    hasBudget: boolean;
  };
  busy: boolean;
  onCancel: () => void;
  onRevise: (budgetMinor: string) => void;
}) {
  const original = BigInt(project.budgetMinor);
  const spent = BigInt(project.spentMinor);
  const [text, setText] = React.useState(() => toInput(project.budgetMinor, project.currency));

  const revised = parseAmount(text, project.currency);
  const blocker =
    revised === null ? "That is not an amount I can read. Arithmetic is allowed — 240000/2 or (85000+15000)*3."
    : revised < 0n ? "A budget cannot be negative. A job quoted at nothing has a budget of nought, which is what an empty box means."
    : revised === original ? "That is the figure it already carries."
    : null;

  const movement = revised === null ? 0n : revised - original;

  return (
    <div className="p-3" style={{ borderTop: "1px solid var(--sw-line)" }} data-testid="budget-revision">
      <div className="sw-label">Revise the budget on {project.code}</div>
      <p className="sw-sub mt-1 max-w-[78ch]">
        What {project.name} is quoted at, and what changing it does to every percentage read against it. Nothing is
        posted: a budget is what the job was sold for, and the ledger holds what it cost.
      </p>

      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="sw-label">Revised budget, {project.currency}</span>
          <span className="mt-1 block">
            <input
              className={`sw-input sw-cell-num ${revised === null ? "sw-cell-invalid" : ""}`}
              style={{ width: "11rem" }}
              inputMode="decimal"
              value={text}
              aria-invalid={revised === null || undefined}
              aria-label={`Revised budget for ${project.code}, in ${project.currency}`}
              onChange={(e) => setText(e.target.value)}
              data-testid="budget-input"
            />
          </span>
        </label>
        <button
          type="button"
          className="sw-btn sw-btn-primary"
          disabled={blocker !== null || busy}
          aria-disabled={blocker !== null || busy || undefined}
          data-testid="save-budget"
          onClick={() => {
            if (blocker || revised === null) return;
            onRevise(revised.toString());
          }}
        >
          {busy ? "Saving…" : "Revise it"}
        </button>
        <button type="button" className="sw-btn" onClick={onCancel} disabled={busy} data-testid="cancel-budget">
          Leave it
        </button>
        {blocker && <span className="sw-sub" role="status" data-testid="budget-blocker">{blocker}</span>}
      </div>

      <div className="sw-scroll mt-3">
        <table className="sw-table" style={{ maxWidth: "44rem" }}>
          <caption className="sr-only">
            The budget on {project.code} as it stands, and as it would be after this revision
          </caption>
          <thead>
            <tr>
              <th />
              <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>As it stands</th>
              <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>As revised</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row" style={{ fontWeight: 400 }}>Budget</th>
              <td className="sw-num" data-testid="budget-before">
                {project.hasBudget
                  ? <Figure minor={original} currency={project.currency} colour={false} />
                  : <span className="sw-zero">none set</span>}
              </td>
              <td className="sw-num" data-testid="budget-after">
                {revised === null
                  ? <span className="sw-zero">–</span>
                  : <Figure minor={revised} currency={project.currency} colour={false} />}
              </td>
            </tr>
            <tr>
              <th scope="row" style={{ fontWeight: 400 }}>Cost to date</th>
              <td className="sw-num"><Figure minor={spent} currency={project.currency} zero="zero" colour={false} /></td>
              <td className="sw-num sw-zero" title="A budget is not a posting. Nothing here touches the ledger.">
                unchanged
              </td>
            </tr>
            <tr>
              <th scope="row" style={{ fontWeight: 400 }}>Remaining</th>
              <td className="sw-num">
                {project.hasBudget
                  ? <Figure minor={original - spent} currency={project.currency} zero="zero" />
                  : <span className="sw-zero">–</span>}
              </td>
              <td className="sw-num">
                {revised === null || revised === 0n
                  ? <span className="sw-zero">–</span>
                  : <Figure minor={revised - spent} currency={project.currency} zero="zero" />}
              </td>
            </tr>
            <tr>
              <th scope="row" style={{ fontWeight: 400 }}>Budget consumed</th>
              <td className="sw-num">{pct(consumedBps(spent, original))}</td>
              <td className="sw-num" data-testid="consumed-after">
                {revised === null ? "–" : pct(consumedBps(spent, revised))}
              </td>
            </tr>
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">Movement</th>
              <td className="sw-num sw-zero">–</td>
              <td className="sw-num" data-testid="budget-movement">
                {revised === null
                  ? <span className="sw-zero">–</span>
                  : <Figure minor={movement} currency={project.currency} zero="zero" />}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      <p className="sw-sub mt-3 max-w-[78ch]" data-testid="budget-history-note">
        A project carries one budget, and this replaces it. There is no revision history behind that column, so once
        this is saved the figure under &ldquo;as it stands&rdquo; is no longer held anywhere &mdash; this panel is the
        last place the two appear side by side. Write down what was agreed and by whom where the next person will look
        for it, because the report will only ever show the figure that survived.
      </p>
    </div>
  );
}
