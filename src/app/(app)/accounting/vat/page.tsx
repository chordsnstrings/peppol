"use client";

import * as React from "react";
import Link from "next/link";
import { api, ApiError, useEntityId, useLedgerQuery } from "@/components/ledger/use-ledger";
import { Figure, PageHead, Panel, ErrorNote, Loading } from "@/components/ledger/primitives";
import {
  RegistrationPanel,
  type RecordedRegistration,
  type RegistrationToRecord,
} from "@/components/ledger/vat-registration";
import {
  ReturnsPanel,
  filingRecorded,
  type FilingToRecord,
  type OutstandingPeriod,
} from "@/components/ledger/vat-filing";

interface Box { box: string; label: string; amountMinor: string; vatMinor: string | null; adjustmentMinor: string | null }
interface Outside { taxCode: string; label: string; amountMinor: string; note: string }
interface TaxPeriod {
  label: string; from: string; to: string; dueOn: string;
  matchesRequest: boolean; filedOn: string | null;
}
interface Ret {
  periodFrom: string; periodTo: string; currency: string;
  taxPeriod: TaxPeriod | null;
  sales: Box[]; expenses: Box[];
  outsideTheReturn: Outside[];
  totalOutputVatMinor: string; totalInputVatMinor: string; netVatMinor: string; payable: boolean;
  reconciliation: { outputVatPerLedgerMinor: string; inputVatPerLedgerMinor: string; outputMatches: boolean; inputMatches: boolean };
  warnings: string[];
  voluntaryDisclosure: VoluntaryDisclosure;
}

interface VoluntaryDisclosure {
  thresholdMinor: string;
  currencyDiffers: boolean;
  corrections: {
    reference: string; entryDate: string;
    originalReference: string; originalDate: string; originalPeriodLabel: string;
    filedOn: string | null;
    outputVatMinor: string; inputVatMinor: string; netMinor: string;
  }[];
  byPeriod: { label: string; filedOn: string | null; netMinor: string; overThreshold: boolean; corrections: number }[];
  largestMinor: string;
  note: string;
}

interface Choice { label: string; from: string; to: string }
interface Periods {
  registration: RecordedRegistration | null;
  periods: { label: string; from: string; to: string; dueOn: string }[];
  /**
   * Which returns have ended with no filing recorded, and the server's own
   * sentence about why that list is what it is. Both are read here rather than
   * derived, because `recordFiling` accepts exactly these period labels and a
   * list assembled on this side would drift from the one it validates against.
   */
  outstanding: {
    registered: boolean;
    periods: OutstandingPeriod[];
    note: string;
  };
}

/**
 * Calendar quarters and months, for an entity whose FTA tax period nobody has
 * recorded.
 *
 * These are a guess and the screen says so. The FTA assigns a tax period on
 * registration and does not give everybody the same one — a registrant on the
 * Feb/May/Aug/Nov stagger has no calendar quarter at all — so where the
 * registration IS recorded the picker is built from it instead.
 */
function calendarPeriods(year: number): Choice[] {
  const q = [
    { label: `${year} Q1`, from: `${year}-01-01`, to: `${year}-03-31` },
    { label: `${year} Q2`, from: `${year}-04-01`, to: `${year}-06-30` },
    { label: `${year} Q3`, from: `${year}-07-01`, to: `${year}-09-30` },
    { label: `${year} Q4`, from: `${year}-10-01`, to: `${year}-12-31` },
  ];
  const m = Array.from({ length: 12 }, (_, i) => {
    const mm = String(i + 1).padStart(2, "0");
    const last = new Date(Date.UTC(year, i + 1, 0)).getUTCDate();
    return { label: `${year}-${mm}`, from: `${year}-${mm}-01`, to: `${year}-${mm}-${last}` };
  });
  return [...q, ...m];
}

/** The last period that has actually ended — the one there is a return to prepare for. */
function lastEnded(choices: Choice[], today: string): Choice {
  const ended = choices.filter((c) => c.to < today);
  return ended[ended.length - 1] ?? choices[0];
}

export default function VatReturnPage() {
  const entityId = useEntityId();
  const today = new Date().toISOString().slice(0, 10);
  const year = Number(today.slice(0, 4));

  // The registration first, because it decides what the picker may offer. A
  // year either side, so the period that straddles a year end is on the list.
  const { data: periodData, reload: reloadPeriods } = useLedgerQuery<Periods>(
    entityId
      ? `/api/ledger/tax-periods?entityId=${entityId}&regime=VAT&from=${year - 1}-01-01&to=${year}-12-31`
      : null,
  );
  const registration = periodData?.registration ?? null;
  const choices: Choice[] = React.useMemo(() => {
    if (registration && periodData?.periods.length) {
      return periodData.periods.map((p) => ({ label: p.label, from: p.from, to: p.to }));
    }
    return calendarPeriods(year);
  }, [registration, periodData, year]);

  // Null until somebody picks, so the default follows whichever list is in
  // play rather than being frozen at the calendar quarter chosen on first
  // render — the registration arrives a moment after the screen does.
  const [sel, setSel] = React.useState<string | null>(null);
  const period = choices.find((p) => p.label === sel) ?? lastEnded(choices, today);

  const { data, error, loading, reload: reloadReturn } = useLedgerQuery<Ret>(
    entityId ? `/api/ledger/vat?entityId=${entityId}&from=${period.from}&to=${period.to}` : null,
  );

  const [busy, setBusy] = React.useState<string | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);

  /**
   * The two writes this screen makes, both to the same route.
   *
   * Both reads are reloaded afterwards and not only the one that changed: a
   * registration decides which periods exist, and a filing decides whether the
   * return on screen is one that has already gone in, so either write can
   * change what the other read says.
   */
  const act = async (label: string, body: Record<string, unknown>, describe: string): Promise<boolean> => {
    setBusy(label); setErr(null); setMsg(null);
    try {
      await api("/api/ledger/tax-periods", {
        method: "POST",
        body: JSON.stringify({ entityId, ...body }),
      });
      setMsg(describe);
      reloadPeriods();
      reloadReturn();
      return true;
    } catch (e) {
      // The route's refusals name the thing that is wrong — a TRN a digit
      // short, a period still running, a return already filed and by whom — so
      // they are shown as they stand.
      setErr(e instanceof ApiError ? e.message : "That did not work.");
      // False, so the form that asked stays open with what was typed in it —
      // a refusal is a thing to correct, not a thing to retype.
      return false;
    } finally {
      setBusy(null);
    }
  };

  if (!entityId) return <Loading label="Choosing an entity…" />;

  const calendar = !registration;
  /* The currency of the figure a filing records is the book's own, which only
   * the computed return publishes. Where it has not arrived the forms fall back
   * to dirhams, exactly as the receipt forms do and for the same reason: every
   * book this product opens is opened in AED, and it is an assumption rather
   * than a fact the ledger has stated here. */
  const currency = data?.currency ?? "AED";

  return (
    <>
      <PageHead
        title="VAT return"
        sub="The VAT 201 boxes, computed from the same journal lines as the trial balance rather than from a second pass over the invoices — so the return and the books cannot disagree. Review it, then file with the FTA."
        actions={
          <>
            <label className="flex items-center gap-2">
              <span className="sw-label">Period</span>
              <select
                className="sw-select"
                style={{ width: "11rem" }}
                value={period.label}
                onChange={(e) => setSel(e.target.value)}
              >
                {calendar ? (
                  <>
                    <optgroup label="Quarters">
                      {choices.slice(0, 4).map((p) => <option key={p.label} value={p.label}>{p.label}</option>)}
                    </optgroup>
                    <optgroup label="Months">
                      {choices.slice(4).map((p) => <option key={p.label} value={p.label}>{p.label}</option>)}
                    </optgroup>
                  </>
                ) : (
                  <optgroup label="Your tax periods">
                    {choices.map((p) => <option key={p.label} value={p.label}>{p.label}</option>)}
                  </optgroup>
                )}
              </select>
            </label>
            {/* Whether the list above is a fact or a guess, said where the list
                is — a screen that shows both kinds of period identically is how
                somebody files for the wrong three months. Nothing is claimed
                until the read lands: "assumed" on a registered entity, for the
                moment before its registration arrives, would be a lie the
                screen tells every time it opens. */}
            {periodData && <span
              className={`sw-chip ${calendar ? "sw-chip-warn" : "sw-chip-ok"}`}
              title={
                calendar
                  ? "No FTA registration is recorded, so these are calendar quarters and months rather than the periods the Authority assigned"
                  : "These are the periods the recorded registration implies"
              }
              data-testid="period-source"
            >
              {calendar ? "assumed" : "recorded"}
            </span>}
          </>
        }
      />

      {err && <ErrorNote>{err}</ErrorNote>}
      {msg && <div className="sw-note mb-3" role="status" data-testid="vat-result">{msg}</div>}
      {error && <ErrorNote>{error}</ErrorNote>}
      {loading && <Loading />}

      {/* Ahead of everything the return says, because a warning about a return
          computed for the wrong period is worth reading before the boxes. */}
      {data?.warnings.map((w, i) => (
        <div key={i} className="sw-error mb-3" role="alert" data-testid="vat-warning">{w}</div>
      ))}

      {/* Outside the block below: the registration is exactly what somebody
          needs when the return itself could not be computed. */}
      {periodData && (
        <>
          <RegistrationPanel
            registration={periodData.registration}
            busy={busy === "register"}
            onRecord={(r: RegistrationToRecord) =>
              act(
                "register",
                { action: "register", ...r },
                periodData.registration
                  ? "The registration is amended. The periods from here on come from it."
                  : "The registration is recorded. Every VAT period and deadline now comes from it rather than from the calendar.",
              )
            }
          />
          <ReturnsPanel
            registered={periodData.outstanding.registered}
            note={periodData.outstanding.note}
            periods={periodData.outstanding.periods}
            computed={
              data?.taxPeriod
                ? { periodLabel: data.taxPeriod.label, netVatMinor: data.netVatMinor, payable: data.payable }
                : null
            }
            currency={currency}
            today={today}
            busy={busy === "file"}
            onFile={(f: FilingToRecord) =>
              act("file", { action: "file", ...f }, filingRecorded(f, currency))
            }
          />
        </>
      )}

      {data && (
        <>
          <TaxPeriodPanel period={data.taxPeriod} from={data.periodFrom} to={data.periodTo} />

          <DisclosurePanel vd={data.voluntaryDisclosure} currency={data.currency} />

          <div className="grid gap-4 lg:grid-cols-2">
            <BoxTable
              title="VAT on sales and all other outputs"
              rows={data.sales}
              currency={data.currency}
              note={
                <>
                  Box 1 is seven rows because the VAT 201 splits standard-rated supplies between the emirates —
                  the tax collected is distributed between them on that basis, so the split decides where the
                  money goes. Row 1x is not a box on the FTA&rsquo;s form: it is the supplies whose emirate this
                  ledger does not hold, shown rather than spread across the other seven, and it has to be
                  attributed before the return is filed. The emirate recorded is the one on the selling
                  establishment&rsquo;s address at the moment the invoice posted, so a business that supplies
                  from more than one emirate should check it rather than trust it.
                </>
              }
            />
            <BoxTable title="VAT on expenses and all other inputs" rows={data.expenses} currency={data.currency} />
          </div>

          <OutsideTheReturn rows={data.outsideTheReturn} currency={data.currency} />

          <Panel className="mt-4 p-4">
            <div className="sw-label">Net VAT due</div>
            <div className="mt-3 grid gap-4 sm:grid-cols-3">
              <Stat label="Box 12 — total output tax" value={<Figure minor={data.totalOutputVatMinor} currency={data.currency} zero="zero" colour={false} />} />
              <Stat label="Box 13 — total input tax" value={<Figure minor={data.totalInputVatMinor} currency={data.currency} zero="zero" colour={false} />} />
              <Stat
                label={data.payable ? "Box 14 — payable to the FTA" : "Box 14 — reclaimable from the FTA"}
                value={<Figure minor={data.netVatMinor} currency={data.currency} zero="zero" />}
              />
            </div>
            <p className="sw-sub mt-3">
              {data.payable
                ? "This is what you owe for the period."
                : "Input tax exceeded output tax, so this period is a reclaim rather than a payment."}
            </p>
          </Panel>

          <Panel className="mt-4 p-4">
            <div className="sw-label">Reconciliation to the ledger</div>
            <p className="sw-sub mt-1.5 max-w-[70ch]">
              These are the same figures summed a second way, straight off the control accounts. They have to agree —
              if they ever do not, the return is wrong and should not be filed.
            </p>
            <table className="sw-table mt-3" style={{ maxWidth: "34rem" }}>
              <caption className="sr-only">The return against the VAT control accounts in the ledger</caption>
              <tbody>
                <Recon
                  label="Output tax"
                  account="2100"
                  ret={data.totalOutputVatMinor}
                  ledger={data.reconciliation.outputVatPerLedgerMinor}
                  ok={data.reconciliation.outputMatches}
                  currency={data.currency}
                />
                <Recon
                  label="Input tax"
                  account="1350"
                  ret={data.totalInputVatMinor}
                  ledger={data.reconciliation.inputVatPerLedgerMinor}
                  ok={data.reconciliation.inputMatches}
                  currency={data.currency}
                />
              </tbody>
            </table>
          </Panel>

          <p className="sw-sub mt-3">
            Period {data.periodFrom} to {data.periodTo}. This computes the return; filing it is a
            separate act, taken on figures you have looked at.
          </p>
        </>
      )}
    </>
  );
}

/**
 * Which tax period the figures are actually for.
 *
 * A return is filed for a tax period the FTA assigned, not for a span of dates
 * somebody picked off a calendar. Where the registration is recorded this says
 * which period, when it falls due and whether a filing has been recorded
 * against it; where it is not, it says that too rather than letting the dates
 * in the picker pass for a tax period.
 */
/**
 * Corrections made in this period to returns already filed.
 *
 * `reverse()` refuses a closed period, so a correction to a filed quarter has
 * to land in an open one — and it then flows into THIS return as ordinary
 * movement, with the tax quietly moving from the quarter it belonged to into
 * the quarter somebody noticed. Article 10 exists to stop exactly that, and
 * nothing on this screen said so.
 *
 * The panel shows the population and refuses to reach a conclusion about it.
 * The ledger cannot tell an error from a legitimate credit note under Articles
 * 61 and 62, and it cannot know when anybody became aware of anything, so it
 * cannot start the twenty-day clock. Guessing here would be wrong in the
 * direction that costs somebody a penalty.
 */
function DisclosurePanel({ vd, currency }: { vd: VoluntaryDisclosure; currency: string }) {
  if (vd.corrections.length === 0) return null;
  const over = vd.byPeriod.some((p) => p.overThreshold);

  return (
    <Panel className="mb-4 overflow-hidden">
      <div className="border-b px-3 py-2" style={{ borderColor: "var(--sw-line)", background: "var(--sw-surface-2)" }}>
        <span className="sw-label">Corrections to returns already filed</span>
      </div>
      <div className="p-3">
        <p className="sw-sub mb-2" style={{ maxWidth: "80ch" }} data-testid="disclosure-note">{vd.note}</p>
        <div className="sw-scroll">
          <table className="sw-table" data-testid="voluntary-disclosure">
            <caption className="sr-only">Reversals in this period of entries belonging to filed returns</caption>
            <thead>
              <tr>
                <th scope="col">Return</th>
                <th scope="col">Filed</th>
                <th scope="col" className="sw-num">Entries</th>
                <th scope="col" className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Tax moved</th>
                <th scope="col">Article 10</th>
              </tr>
            </thead>
            <tbody>
              {vd.byPeriod.map((p) => (
                <tr key={p.label}>
                  <th scope="row">{p.label}</th>
                  <td className="sw-sub">{p.filedOn ?? "closed, no filing recorded"}</td>
                  <td className="sw-num">{p.corrections}</td>
                  <td className="sw-num">
                    <Figure minor={p.netMinor} currency={currency} zero="zero" />
                  </td>
                  <td>
                    {p.overThreshold
                      ? <span className="sw-chip sw-chip-warn">over AED 10,000</span>
                      : <span className="sw-sub">under the threshold</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {over && (
          <p className="sw-sub mt-2" style={{ maxWidth: "80ch" }}>
            A correction above AED 10,000 to a filed return is a voluntary disclosure within 20 business days of
            becoming aware of it, not a line on the next return. Below the threshold it goes on the next return.
            Which of these is an error and which is a credit note is a judgement nobody here can make for you.
          </p>
        )}

        <details className="mt-2">
          <summary className="sw-sub" style={{ cursor: "pointer" }}>
            The {vd.corrections.length} {vd.corrections.length === 1 ? "entry" : "entries"} behind these figures
          </summary>
          <div className="sw-scroll mt-1">
            <table className="sw-table" data-testid="voluntary-disclosure-entries">
              <caption className="sr-only">Each reversal and the entry it reversed</caption>
              <thead>
                <tr>
                  <th scope="col">Reversal</th>
                  <th scope="col">Posted</th>
                  <th scope="col">Reversed</th>
                  <th scope="col">Originally</th>
                  <th scope="col">Return</th>
                  <th scope="col" className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Tax moved</th>
                </tr>
              </thead>
              <tbody>
                {vd.corrections.map((c) => (
                  <tr key={c.reference}>
                    <th scope="row" className="sw-code">{c.reference}</th>
                    <td className="sw-sub">{c.entryDate}</td>
                    <td className="sw-code">{c.originalReference}</td>
                    <td className="sw-sub">{c.originalDate}</td>
                    <td className="sw-sub">{c.originalPeriodLabel}</td>
                    <td className="sw-num">
                      <Figure minor={c.netMinor} currency={currency} zero="zero" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </div>
    </Panel>
  );
}

function TaxPeriodPanel({ period, from, to }: { period: TaxPeriod | null; from: string; to: string }) {
  if (!period) {
    return (
      <Panel className="mb-4 p-4">
        <div className="sw-label">Tax period</div>
        <p className="sw-sub mt-1.5 max-w-[70ch]" data-testid="vat-no-registration">
          No FTA tax period is recorded for this entity, so this return covers exactly the dates chosen above —
          {" "}{from} to {to} — and the periods offered are calendar quarters and months. The Authority assigns a
          tax period on registration and does not give everybody the same one: a registrant on the
          February, May, August and November stagger has no calendar quarter at all. Record it in the FTA
          registration panel above and the periods, the deadline and the reminders all come from it instead.
        </p>
      </Panel>
    );
  }
  return (
    <Panel className="mb-4 p-4">
      <div className="sw-label">Tax period</div>
      <div className="mt-3 grid gap-4 sm:grid-cols-3">
        <Stat label="Period" value={<span data-testid="vat-period-label">{period.label}</span>} />
        <Stat label="Due to the FTA" value={period.dueOn} />
        <Stat
          label="Filed"
          value={
            period.filedOn
              ? <span className="sw-chip sw-chip-ok">{period.filedOn}</span>
              : <span className="sw-chip sw-chip-warn">not recorded</span>
          }
        />
      </div>
      <p className="sw-sub mt-3 max-w-[70ch]">
        {period.from} to {period.to}
        {period.matchesRequest ? "" : " — the dates asked for were not this registration's period, so they were replaced by it"}
        . The return is due on the 28th day following the end of the tax period (Article 64 of the Executive
        Regulation).
      </p>
    </Panel>
  );
}

function BoxTable({
  title, rows, currency, note,
}: { title: string; rows: Box[]; currency: string; note?: React.ReactNode }) {
  // The Adjustment column appears only where a box on this side of the form has
  // one. An empty fourth column on the sales table would read as "no
  // adjustments" when what it means is "not reported here".
  const hasAdjustments = rows.some((b) => b.adjustmentMinor !== null);
  return (
    <Panel className="overflow-hidden">
      <div className="border-b px-3 py-2" style={{ borderColor: "var(--sw-line)", background: "var(--sw-surface-2)" }}>
        <span className="sw-label">{title}</span>
      </div>
      <div className="sw-scroll">
        <table className="sw-table">
          <caption className="sr-only">{title}</caption>
          <thead>
            <tr>
              <th style={{ width: "3.5rem" }}>Box</th>
              <th>Description</th>
              <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Amount</th>
              <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>VAT</th>
              {hasAdjustments && (
                <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Adjustment</th>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map((b) => (
              <tr key={b.box}>
                <td className="sw-code">{b.box}</td>
                <td>{b.label}</td>
                <td className="sw-num"><Figure minor={b.amountMinor} currency={currency} colour={false} /></td>
                <td className="sw-num">
                  {b.vatMinor === null
                    ? <span className="sw-zero" title="This box carries no VAT">–</span>
                    : <Figure minor={b.vatMinor} currency={currency} colour={false} />}
                </td>
                {hasAdjustments && (
                  <td className="sw-num" data-testid={`vat-adjustment-${b.box}`}>
                    {b.adjustmentMinor === null
                      ? <span className="sw-zero" title="No adjustment column is reported for this box">–</span>
                      : <Figure minor={b.adjustmentMinor} currency={currency} colour={false} />}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {hasAdjustments && (
        <p className="sw-sub border-t px-3 py-2" style={{ borderColor: "var(--sw-line)" }}>
          An adjustment is tax that belongs to this period without a supply of this period behind it — a capital
          asset adjustment under Articles 57 and 58 of the Executive Regulation. It has its own column so that it is
          never shown as tax on expenses nobody incurred. It is already inside the totals below.
        </p>
      )}
      {note && (
        <p className="sw-sub border-t px-3 py-2" style={{ borderColor: "var(--sw-line)" }}>{note}</p>
      )}
    </Panel>
  );
}

/**
 * Supplies that reached the books under a treatment no box of the VAT 201
 * carries. Shown rather than dropped: a figure that is on none of the boxes is
 * still a figure somebody has to be able to find, and the panel is where the
 * revenue in the books ties back to the revenue on the return.
 */
function OutsideTheReturn({ rows, currency }: { rows: Outside[]; currency: string }) {
  const shown = rows.filter((r) => BigInt(r.amountMinor) !== 0n);
  if (!shown.length) return null;
  return (
    <Panel className="mt-4 p-4">
      <div className="sw-label">Outside the return</div>
      <p className="sw-sub mt-1.5 max-w-[70ch]">
        These supplies are on the books for the period and on none of the boxes above. They are not zero rated —
        a zero-rated supply is inside the scope of UAE VAT at a rate of nothing, and these are outside it
        altogether.
      </p>
      <table className="sw-table mt-3">
        <caption className="sr-only">Supplies that belong on no box of the return</caption>
        <tbody>
          {shown.map((r) => (
            <tr key={r.taxCode} data-testid={`vat-outside-${r.taxCode}`}>
              <td>
                {r.label}
                <p className="sw-sub mt-1 max-w-[70ch]">{r.note}</p>
              </td>
              <td className="sw-num" style={{ width: "var(--sw-col-amount)", verticalAlign: "top" }}>
                <Figure minor={r.amountMinor} currency={currency} colour={false} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}

function Recon({ label, account, ret, ledger, ok, currency }: {
  label: string; account: string; ret: string; ledger: string; ok: boolean; currency: string;
}) {
  return (
    <tr>
      <td>{label}</td>
      <td className="sw-num"><Figure minor={ret} currency={currency} zero="zero" colour={false} /></td>
      <td className="sw-code" style={{ textAlign: "center" }}>vs</td>
      <td className="sw-num"><Figure minor={ledger} currency={currency} zero="zero" colour={false} /></td>
      <td>
        <Link href={`/accounting/accounts/${account}`} className="sw-link">{account}</Link>{" "}
        <span className={`sw-chip ${ok ? "sw-chip-ok" : "sw-chip-bad"}`}>{ok ? "agrees" : "differs"}</span>
      </td>
    </tr>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="sw-label">{label}</div>
      <div className="mt-0.5 text-[1.0625rem] font-semibold tabular-nums">{value}</div>
    </div>
  );
}
