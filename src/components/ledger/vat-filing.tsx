"use client";

import * as React from "react";
import { Figure, Empty, Panel } from "./primitives";
import { fmtMinor, parseAmount, toInput } from "@/lib/ledger/format";

/**
 * Recording that a return went in.
 *
 * Nothing here files anything: no part of this product talks to EmaraTax, and
 * the whole point of `recordFiling` is that "is this filed" stops being
 * inferred from whether somebody closed a month. Until now it was inferred,
 * because the verb was routed and unreachable — the Filed chip on this screen
 * could never turn green, and the attention list went on chasing a return that
 * had been submitted weeks earlier.
 *
 * The periods offered are the ones the server says are outstanding, not a list
 * built here. `recordFiling` refuses a label that is not a period of this
 * registration and refuses a period that has not ended, and a picker assembled
 * independently would offer both and find out at the far end.
 */

export interface OutstandingPeriod {
  label: string;
  from: string;
  to: string;
  dueOn: string;
  daysOverdue: number;
  overdue: boolean;
}

export interface FilingToRecord {
  periodLabel: string;
  filedOn: string;
  reference: string;
  /** Signed minor units: positive payable, negative reclaimable. */
  netVatMinor: string | null;
}

/** The figure this screen has already computed, where it is for this period. */
export interface ComputedReturn {
  periodLabel: string;
  netVatMinor: string;
  payable: boolean;
}

export function ReturnsPanel({
  registered,
  note,
  periods,
  computed,
  currency,
  today,
  busy,
  onFile,
}: {
  registered: boolean;
  /** The server's own sentence about why the list is what it is. */
  note: string;
  periods: OutstandingPeriod[];
  computed: ComputedReturn | null;
  currency: string;
  today: string;
  busy: boolean;
  /** Answers true once it is recorded, so the form knows whether to clear. */
  onFile: (f: FilingToRecord) => Promise<boolean>;
}) {
  return (
    <Panel className="mb-4 overflow-hidden">
      <div className="border-b px-3 py-2" style={{ borderColor: "var(--sw-line)", background: "var(--sw-surface-2)" }}>
        <span className="sw-label">Returns outstanding</span>
      </div>

      {!registered ? (
        <p className="sw-sub max-w-[80ch] px-3 py-3" data-testid="returns-unregistered">{note}</p>
      ) : (
        <>
          {periods.length === 0 ? (
            <div className="px-3 py-3">
              <Empty>
                Every tax period that has ended has a filing recorded against it. A period still running is not
                listed: there is nothing to file for it yet.
              </Empty>
            </div>
          ) : (
            <div className="sw-scroll">
              <table className="sw-table" data-testid="outstanding-returns">
                <caption className="sr-only">Tax periods that have ended with no filing recorded</caption>
                <thead>
                  <tr>
                    <th style={{ width: "11rem" }}>Period</th>
                    <th style={{ width: "8rem" }}>Ended</th>
                    <th style={{ width: "8rem" }}>Due</th>
                    <th>Standing</th>
                  </tr>
                </thead>
                <tbody>
                  {periods.map((p) => (
                    <tr key={p.label}>
                      <th scope="row">{p.label}</th>
                      <td className="sw-sub">{p.to}</td>
                      <td className="sw-sub">{p.dueOn}</td>
                      <td>
                        {p.overdue ? (
                          <span className="sw-chip sw-chip-bad">
                            {p.daysOverdue} day{p.daysOverdue === 1 ? "" : "s"} late
                          </span>
                        ) : (
                          <span className="sw-chip sw-chip-warn">not filed</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {periods.length > 0 && (
            <div className="border-t p-3" style={{ borderColor: "var(--sw-line)" }}>
              <FilingForm
                periods={periods}
                computed={computed}
                currency={currency}
                today={today}
                busy={busy}
                onFile={onFile}
              />
            </div>
          )}

          <p className="sw-sub border-t px-3 py-2" style={{ borderColor: "var(--sw-line)" }}>{note}</p>
        </>
      )}
    </Panel>
  );
}

/**
 * The form.
 *
 * The net figure is prefilled only from the return this screen has actually
 * computed, and only for the period it computed it for. Carrying the figure
 * across to another period would put a number somebody never looked at into a
 * record of what was submitted, and the record is the only place the ledger
 * will ever hold what the FTA was told.
 */
function FilingForm({
  periods,
  computed,
  currency,
  today,
  busy,
  onFile,
}: {
  periods: OutstandingPeriod[];
  computed: ComputedReturn | null;
  currency: string;
  today: string;
  busy: boolean;
  onFile: (f: FilingToRecord) => Promise<boolean>;
}) {
  // The oldest outstanding period, which is the one to deal with first.
  const [label, setLabel] = React.useState(periods[0].label);
  const [filedOn, setFiledOn] = React.useState(today);
  const [reference, setReference] = React.useState("");
  const [amount, setAmount] = React.useState("");
  const [direction, setDirection] = React.useState<"payable" | "reclaimable">("payable");
  // Until somebody types, the amount is whatever the computed return says for
  // the period selected — which changes as the selection changes.
  const [touched, setTouched] = React.useState(false);

  const period = periods.find((p) => p.label === label) ?? periods[0];
  const suggestion = computed && computed.periodLabel === period.label ? computed : null;
  const suggested = suggestion
    ? {
        amount: toInput(BigInt(suggestion.netVatMinor) < 0n ? -BigInt(suggestion.netVatMinor) : BigInt(suggestion.netVatMinor), currency),
        direction: (suggestion.payable ? "payable" : "reclaimable") as "payable" | "reclaimable",
      }
    : null;

  const shownAmount = touched || !suggested ? amount : suggested.amount;
  const shownDirection = touched || !suggested ? direction : suggested.direction;

  const typed = shownAmount.trim();
  const parsed = typed === "" ? null : parseAmount(typed, currency);
  const netVatMinor =
    parsed === null ? null : (shownDirection === "payable" ? parsed : -parsed).toString();

  const blocker =
    typed !== "" && parsed === null
      ? "That is not an amount this ledger can read."
      : parsed !== null && parsed < 0n
        // Which way it went is the picker beside the box, and a minus sign as
        // well would be two answers to one question — a negative payable and a
        // positive reclaim are the same figure said twice.
        ? "Write the amount without a sign, and say which way it went beside it."
      : filedOn < period.to
        ? `The ${period.label} return cannot have been filed on ${filedOn}: the period it covers only ended on ${period.to}.`
        : filedOn > today
          ? "A return cannot be recorded as filed on a date that has not arrived."
          : null;

  return (
    <>
      <div className="sw-label">Record a return as filed</div>
      <p className="sw-sub mt-1 max-w-[80ch]">
        This records that somebody submitted the return; it does not submit one. Nothing in this product talks to
        EmaraTax, and a correction to a return already recorded as filed is a voluntary disclosure rather than a
        second filing, so the reference and the date want to be the ones on the acknowledgement.
      </p>

      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Period">
          <select
            className="sw-select"
            value={period.label}
            /* Choosing another period empties what was typed for the last one.
               A reference and a figure belong to one return, and carrying them
               across is how the wrong acknowledgement number ends up recorded
               against a quarter nobody checked. */
            onChange={(e) => { setLabel(e.target.value); setTouched(false); setAmount(""); setReference(""); }}
            data-testid="filing-period"
          >
            {periods.map((p) => <option key={p.label} value={p.label}>{p.label}</option>)}
          </select>
          <span className="sw-sub mt-1 block">{period.from} to {period.to}, due {period.dueOn}.</span>
        </Field>
        <Field label="Filed on">
          <input type="date" className="sw-input" value={filedOn} onChange={(e) => setFiledOn(e.target.value)} />
        </Field>
        <Field label="FTA reference">
          <input
            className="sw-input"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            placeholder="From the acknowledgement"
          />
        </Field>
        <Field label={`Net VAT (${currency})`}>
          <span className="flex gap-1">
            <input
              className="sw-input sw-cell-num"
              inputMode="decimal"
              value={shownAmount}
              onChange={(e) => { setTouched(true); setAmount(e.target.value); }}
              placeholder="0.00"
              aria-label="What the return came to"
              data-testid="filing-amount"
            />
            <select
              className="sw-select"
              style={{ width: "9rem" }}
              value={shownDirection}
              onChange={(e) => { setTouched(true); setDirection(e.target.value as "payable" | "reclaimable"); }}
              aria-label="Which way the net VAT went"
            >
              <option value="payable">Payable</option>
              <option value="reclaimable">Reclaimable</option>
            </select>
          </span>
          <span className="sw-sub mt-1 block">
            {suggested && !touched
              ? `The figure this screen computed for ${period.label}. Change it if what went in differs.`
              : suggestion
                ? "As typed, not as computed."
                : `This screen has not computed ${period.label} — choose it in the period picker above to see the boxes, or type what was submitted.`}
          </span>
        </Field>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="sw-btn sw-btn-primary"
          aria-disabled={blocker !== null || busy || undefined}
          disabled={blocker !== null || busy}
          data-testid="record-filing"
          onClick={async () => {
            const done = await onFile({
              periodLabel: period.label,
              filedOn,
              reference: reference.trim(),
              netVatMinor,
            });
            // Cleared only once it is recorded. The period that was just filed
            // leaves the outstanding list, so leaving a reference and an amount
            // behind would carry one return's figures onto the next one.
            if (done) { setTouched(false); setAmount(""); setReference(""); }
          }}
        >
          {busy ? "Recording…" : "Record as filed"}
        </button>
        {blocker && <span className="sw-sub" role="status" data-testid="filing-blocker">{blocker}</span>}
        {!blocker && (
          <span className="sw-sub">
            {netVatMinor === null ? (
              `${period.label} will be recorded as filed on ${filedOn} with no figure against it.`
            ) : (
              <>
                {period.label}, filed {filedOn},{" "}
                {/* The figure as typed, with the direction in words beside it.
                    The signed value is what is sent; showing it here would put
                    a reclaim on screen in parentheses next to the word
                    "reclaimable", which is the same fact twice. */}
                <Figure minor={parsed} currency={currency} zero="zero" colour={false} />{" "}
                {shownDirection === "payable" ? "payable to" : "reclaimable from"} the FTA.
              </>
            )}
          </span>
        )}
      </div>
    </>
  );
}

/** What to say once it is recorded — the same words on both halves of the act. */
export function filingRecorded(f: FilingToRecord, currency: string): string {
  const net = f.netVatMinor === null ? null : BigInt(f.netVatMinor);
  return (
    `The ${f.periodLabel} return is recorded as filed on ${f.filedOn}` +
    (f.reference ? `, reference ${f.reference}` : "") +
    (net === null
      ? "."
      : `, at ${fmtMinor(net < 0n ? -net : net, currency, { zero: "zero" })} ${net < 0n ? "reclaimable" : "payable"}.`)
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="sw-label">{label}</span>
      <span className="mt-1 block">{children}</span>
    </label>
  );
}
