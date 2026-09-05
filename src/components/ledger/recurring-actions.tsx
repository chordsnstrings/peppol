"use client";

import * as React from "react";

/**
 * What can be done to a standing instruction once it exists.
 *
 * Four verbs — edit, pause, resume, end — have been routed since the route was
 * written and the table had no actions column, so a template was a thing you
 * could only create and then watch. That is the one shape of defect a recurring
 * journal makes expensive: a rent accrual whose lease ended in March goes on
 * posting rent every month, and the entry is correct, balanced, dated and
 * completely wrong, and nothing on any screen looks unusual.
 *
 * Pausing and ending are deliberately different acts. A pause is "not this
 * month"; ending is final, and the module refuses to restart an ended template
 * so that the break stays visible in the run history. The control says so
 * before it is pressed rather than after.
 */

export interface TemplateActionRow {
  code: string;
  name: string;
  status: string;
  endsOn: string | null;
}

export function TemplateActions({
  row,
  busy,
  editing,
  today,
  onEdit,
  onPause,
  onResume,
  onEnd,
}: {
  row: TemplateActionRow;
  busy: boolean;
  editing: boolean;
  /** The day the screen opened on, so the end date defaults to something real. */
  today: string;
  onEdit: () => void;
  onPause: () => void;
  onResume: () => void;
  onEnd: (endsOn: string) => void;
}) {
  const [ending, setEnding] = React.useState(false);
  const [endsOn, setEndsOn] = React.useState(row.endsOn ?? today);
  const ended = row.status === "ended";

  return (
    <span className="flex flex-wrap gap-1 py-1">
      <button
        type="button"
        className="sw-btn sw-btn-sm"
        aria-expanded={editing}
        onClick={onEdit}
        data-testid={`edit-${row.code}`}
      >
        {editing ? "Close" : "Edit"}
      </button>

      {!ended && !ending && (
        <>
          {row.status === "paused" ? (
            <button
              type="button"
              className="sw-btn sw-btn-sm"
              disabled={busy}
              title="It starts posting again from the period it is next due for"
              onClick={onResume}
              data-testid={`resume-${row.code}`}
            >
              Resume
            </button>
          ) : (
            <button
              type="button"
              className="sw-btn sw-btn-sm"
              disabled={busy}
              title="It stops posting and keeps everything it is — the run history, the lines, the dates"
              onClick={onPause}
              data-testid={`pause-${row.code}`}
            >
              Pause
            </button>
          )}
          <button
            type="button"
            className="sw-btn sw-btn-sm"
            disabled={busy}
            onClick={() => { setEnding(true); setEndsOn(row.endsOn ?? today); }}
            data-testid={`end-${row.code}`}
          >
            End
          </button>
        </>
      )}

      {ending && (
        <span className="flex flex-wrap items-center gap-1">
          <label className="sr-only" htmlFor={`ends-${row.code}`}>
            The date to record as {row.code}&rsquo;s end
          </label>
          <input
            id={`ends-${row.code}`}
            type="date"
            className="sw-input sw-input-sm"
            style={{ width: "9.5rem" }}
            value={endsOn}
            onChange={(e) => setEndsOn(e.target.value)}
          />
          <button
            type="button"
            className="sw-btn sw-btn-sm"
            disabled={busy}
            onClick={() => { onEnd(endsOn); setEnding(false); }}
            data-testid={`confirm-end-${row.code}`}
          >
            {busy ? "Ending…" : "End it"}
          </button>
          <button type="button" className="sw-btn sw-btn-sm" onClick={() => setEnding(false)}>Cancel</button>
          {/* The distinction that decides which control somebody wants. Ending
              takes the template out of service at once, whatever date is
              recorded on it — `assessDue` refuses an ended template before it
              looks at any date. A template that should go on posting until a
              known month and stop after it is edited, not ended. */}
          <span className="sw-sub block">
            Ending stops it now, for good. To let it run to a date and stop after that, set the end date on the
            template with Edit instead.
          </span>
        </span>
      )}

      {ended && (
        <span className="sw-sub">{row.endsOn ? `Ended ${row.endsOn}` : "Ended"}</span>
      )}
    </span>
  );
}

/** What the end control is about to do, in a sentence the row can carry. */
export function endingMeans(row: TemplateActionRow, endsOn: string): string {
  return (
    `${row.code} ${row.name} is ended, with ${endsOn} recorded as its end. It posts nothing more from now — ` +
    `including any period up to ${endsOn} it had not yet run — the journals it has already posted stay exactly ` +
    `as they are and still point at it, and it cannot be restarted: a template that starts again is a new one, ` +
    `so that the break is visible.`
  );
}
