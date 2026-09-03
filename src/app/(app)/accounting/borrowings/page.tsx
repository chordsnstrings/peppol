"use client";

import * as React from "react";
import { api, ApiError, useEntityId, useLedgerQuery } from "@/components/ledger/use-ledger";
import { Figure, PageHead, Panel, ErrorNote, Loading, Empty, StatusChip } from "@/components/ledger/primitives";
import { parseAmount } from "@/lib/ledger/format";

interface Facility {
  code: string; lender: string; currency: string; status: string;
  drawdownOn: string; maturesOn: string; termMonths: number;
  frequency: string; interestBasis: string;
  principalMinor: string; instalmentMinor: string; instalments: number; paidTo: number;
  statedRateBps: number; statedPeriodRateBps: number; effectiveRateBps: number; ratePremiumBps: number;
  flatInterestMinor: string | null;
  outstandingMinor: string;
  currentMinor: string; nonCurrentMinor: string; reclassifiedMinor: string; splitPosted: boolean;
  totalInterestMinor: string;
  covenants: number;
  notes: string | null;
}
interface Band {
  band: string; label: string;
  principalMinor: string; interestMinor: string; cashFlowMinor: string;
}
interface Maturity {
  asOf: string;
  bands: Band[];
  totals: { principalMinor: string; interestMinor: string; cashFlowMinor: string };
  carryingAmountMinor: string;
  differenceMinor: string;
  facilities: { code: string; lender: string; carryingAmountMinor: string; bands: Record<string, string> }[];
  note: string;
}
interface Register {
  asOf: string;
  facilities: Facility[];
  totals: {
    principalMinor: string; outstandingMinor: string;
    currentMinor: string; nonCurrentMinor: string; reclassifiedMinor: string;
  };
  ledger: {
    nonCurrentMinor: string; currentMinor: string; totalMinor: string;
    agrees: boolean; differenceMinor: string;
  };
  maturity: Maturity;
}
interface ScheduleRow {
  instalmentNo: number; dueOn: string;
  openingMinor: string; interestMinor: string; principalMinor: string;
  instalmentMinor: string; closingMinor: string; posted: boolean;
}
interface Schedule {
  code: string; lender: string; status: string; drawn: boolean;
  interestBasis: string; frequency: string;
  principalMinor: string; instalmentMinor: string; instalments: number; paidTo: number;
  statedRateBps: number; statedPeriodRateBps: number; effectiveRateBps: number;
  flatInterestMinor: string | null;
  rows: ScheduleRow[];
  totals: { interestMinor: string; principalMinor: string; cashMinor: string };
  note: string;
}
interface CovenantTest {
  borrowingCode: string; code: string; metric: string; label: string;
  direction: string; unit: string;
  thresholdBps: number | null; thresholdMinor: string | null;
  actualBps: number | null; actualMinor: string | null;
  result: "pass" | "breach" | "not_tested";
  why: string; wording: string | null;
}
interface Covenants {
  asOf: string; from: string; tests: CovenantTest[];
  breaches: number; untested: number; note: string;
}

const today = () => new Date().toISOString().slice(0, 10);
const pct = (bps: number) => `${(bps / 100).toFixed(2)}%`;
const ratio = (bps: number) => (bps / 10_000).toFixed(2);

const BASIS: Record<string, string> = {
  REDUCING: "reducing balance",
  FLAT: "flat",
};
const FREQUENCY: Record<string, string> = {
  MONTHLY: "monthly", QUARTERLY: "quarterly", SEMIANNUAL: "half-yearly", ANNUAL: "yearly",
};
const RESULT_CHIP: Record<CovenantTest["result"], string> = {
  pass: "sw-chip sw-chip-ok",
  breach: "sw-chip sw-chip-bad",
  not_tested: "sw-chip sw-chip-warn",
};
const RESULT_WORD: Record<CovenantTest["result"], string> = {
  pass: "met", breach: "breached", not_tested: "not tested",
};

export default function BorrowingsPage() {
  const entityId = useEntityId();
  const [asOf, setAsOf] = React.useState(today);
  const { data, error, loading, reload } = useLedgerQuery<Register>(
    entityId ? `/api/ledger/borrowings?entityId=${entityId}&asOf=${asOf}` : null,
    [asOf],
  );
  const covenants = useLedgerQuery<Covenants>(
    entityId ? `/api/ledger/borrowings?entityId=${entityId}&asOf=${asOf}&view=covenants` : null,
    [asOf],
  );

  const [busy, setBusy] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [adding, setAdding] = React.useState(false);
  const [pledging, setPledging] = React.useState(false);
  const [open, setOpen] = React.useState<string | null>(null);
  const [schedule, setSchedule] = React.useState<Schedule | null>(null);

  const act = async (label: string, body: Record<string, unknown>) => {
    setBusy(label); setErr(null); setMsg(null);
    try {
      const r = await api<Record<string, unknown>>("/api/ledger/borrowings", {
        method: "POST", body: JSON.stringify({ entityId, ...body }),
      });
      reload();
      covenants.reload();
      return r;
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "That did not work.");
      return null;
    } finally {
      setBusy(null);
    }
  };

  const showSchedule = async (code: string) => {
    if (open === code) { setOpen(null); setSchedule(null); return; }
    setOpen(code); setSchedule(null); setErr(null);
    try {
      setSchedule(await api<Schedule>(`/api/ledger/borrowings?entityId=${entityId}&code=${encodeURIComponent(code)}`));
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "The schedule would not load.");
    }
  };

  if (!entityId) return <Loading label="Choosing an entity…" />;

  return (
    <>
      <PageHead
        title="Borrowings"
        sub={
          "A loan is carried at amortised cost under IFRS 9, which means the interest charged is the effective rate " +
          "applied to what is still outstanding. On a flat-rate facility that is nowhere near the rate on the offer " +
          "letter, because a flat rate charges the whole of the original sum for the whole of the term. Both rates " +
          "are shown, always."
        }
        actions={
          <>
            <label className="flex items-center gap-1.5">
              <span className="sw-label">As at</span>
              <input
                type="date" className="sw-input" style={{ width: "10rem" }} value={asOf}
                onChange={(e) => setAsOf(e.target.value)}
                aria-label="Reporting date to measure the split and the maturity analysis at"
              />
            </label>
            <button
              type="button" className="sw-btn sw-btn-primary" data-testid="reclassify"
              disabled={busy === "reclassify"}
              onClick={async () => {
                const r = await act("reclassify", { action: "reclassify", asOf });
                if (r) setMsg(String(r.note));
              }}
            >
              {busy === "reclassify" ? "Posting…" : "Split the current portion"}
            </button>
            <button type="button" className="sw-btn" onClick={() => setAdding((a) => !a)} data-testid="toggle-add-borrowing">
              {adding ? "Cancel" : "New facility"}
            </button>
            <button type="button" className="sw-btn" onClick={() => setPledging((a) => !a)} data-testid="toggle-add-covenant">
              {pledging ? "Cancel" : "Record a covenant"}
            </button>
          </>
        }
      />

      {err && <ErrorNote>{err}</ErrorNote>}
      {msg && <div className="sw-note mb-3" role="status" data-testid="borrowing-result">{msg}</div>}
      {error && <ErrorNote>{error}</ErrorNote>}

      {adding && (
        <NewFacility
          busy={busy === "add"}
          onAdd={async (borrowing) => {
            const r = await act("add", { action: "add", borrowing });
            if (r) {
              setAdding(false);
              const b = r.borrowing as { instalmentMinor: string; effectiveRateBps: number };
              setMsg(
                `Recorded ${borrowing.code}. The instalment works out at ${b.instalmentMinor} minor units and the ` +
                `effective rate at ${pct(b.effectiveRateBps)}. Nothing is in the ledger until it is drawn.`,
              );
            }
          }}
        />
      )}

      {pledging && data && (
        <NewCovenant
          busy={busy === "covenant"}
          codes={data.facilities.map((f) => f.code)}
          onAdd={async (covenant) => {
            const r = await act("covenant", { action: "covenant", covenant });
            if (r) { setPledging(false); setMsg(`Recorded covenant ${covenant.code} against ${covenant.borrowingCode}.`); }
          }}
        />
      )}

      {loading && !data && <Loading />}

      {data && (
        <>
          {/* ─────────────────────────────────── register against the ledger */}
          <Panel className="mb-4 p-4">
            <div className="sw-label">Register against the ledger</div>
            <table className="sw-table mt-3" style={{ maxWidth: "46rem" }}>
              <caption className="sr-only">The borrowings register against accounts 2450 and 2500</caption>
              <thead>
                <tr>
                  <th>What is owed</th>
                  <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Register</th>
                  <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Ledger</th>
                </tr>
              </thead>
              <tbody data-testid="register-vs-ledger">
                <tr>
                  <th scope="row" style={{ textAlign: "start" }}>
                    Due within twelve months <span className="sw-code">2450</span>
                  </th>
                  <td className="sw-num"><Figure minor={data.totals.currentMinor} zero="zero" colour={false} /></td>
                  <td className="sw-num"><Figure minor={data.ledger.currentMinor} zero="zero" colour={false} /></td>
                </tr>
                <tr>
                  <th scope="row" style={{ textAlign: "start" }}>
                    Due after twelve months <span className="sw-code">2500</span>
                  </th>
                  <td className="sw-num"><Figure minor={data.totals.nonCurrentMinor} zero="zero" colour={false} /></td>
                  <td className="sw-num"><Figure minor={data.ledger.nonCurrentMinor} zero="zero" colour={false} /></td>
                </tr>
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row" style={{ textAlign: "start" }}>Carrying amount</th>
                  <td className="sw-num" data-testid="register-total">
                    <Figure minor={data.totals.outstandingMinor} zero="zero" />
                  </td>
                  <td className="sw-num"><Figure minor={data.ledger.totalMinor} zero="zero" /></td>
                </tr>
              </tfoot>
            </table>
            <p className="sw-sub mt-2 max-w-[75ch]">
              The two columns split the same total differently until the split is posted. The register column is
              derived from each facility&rsquo;s own repayment schedule at {data.asOf}; the ledger column is what has
              actually been reclassified. IAS 1.69 asks for the part falling due within twelve months of the
              reporting date to be presented as a current liability, and in this product the statements read that
              from the account code — so the split is posted rather than only reported. Press
              &ldquo;Split the current portion&rdquo; to bring the ledger to the register.
            </p>
            {!data.ledger.agrees && (
              <p className="sw-sub mt-2" style={{ color: "var(--sw-neg)" }}>
                The register and the ledger disagree on the total by{" "}
                <Figure minor={data.ledger.differenceMinor} />. That is a finding, not a display problem — a
                facility was probably drawn without its journal posting, or 2450 and 2500 were posted to by hand.
              </p>
            )}
          </Panel>

          {/* ─────────────────────────────────────────────── the facilities */}
          {data.facilities.length === 0 ? (
            <Empty>No facility is on the register yet.</Empty>
          ) : (
            <Panel className="mb-4 overflow-hidden">
              <div className="sw-scroll">
                <table className="sw-table">
                  <caption className="sr-only">Borrowings register</caption>
                  <thead>
                    <tr>
                      <th style={{ width: "6rem" }}>Code</th>
                      <th>Lender</th>
                      <th className="hidden lg:table-cell" style={{ width: "12rem" }}>Term</th>
                      <th className="sw-num" style={{ width: "5.5rem" }}>Quoted</th>
                      <th className="sw-num" style={{ width: "5.5rem" }}>Effective</th>
                      <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Instalment</th>
                      <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Outstanding</th>
                      <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Current</th>
                      <th style={{ width: "6rem" }}>Status</th>
                      <th style={{ width: "13rem" }} />
                    </tr>
                  </thead>
                  <tbody data-testid="borrowing-rows">
                    {data.facilities.map((f) => (
                      <React.Fragment key={f.code}>
                        <tr>
                          <td className="sw-code">{f.code}</td>
                          <td className="max-w-0 truncate">
                            {f.lender}
                            <span className="sw-sub"> · {BASIS[f.interestBasis] ?? f.interestBasis}</span>
                          </td>
                          <td className="hidden lg:table-cell" style={{ color: "var(--sw-fg-muted)" }}>
                            {f.drawdownOn} → {f.maturesOn}
                            <span className="block text-[0.6875rem]">
                              {f.termMonths}m · {f.instalments} {FREQUENCY[f.frequency] ?? f.frequency} instalments
                            </span>
                          </td>
                          <td className="sw-num">{pct(f.statedRateBps)}</td>
                          <td className="sw-num">
                            {pct(f.effectiveRateBps)}
                            {f.ratePremiumBps > 0 && (
                              <span className="block text-[0.6875rem]" style={{ color: "var(--sw-warn)" }}>
                                +{pct(f.ratePremiumBps)}
                              </span>
                            )}
                          </td>
                          <td className="sw-num"><Figure minor={f.instalmentMinor} colour={false} /></td>
                          <td className="sw-num"><Figure minor={f.outstandingMinor} colour={false} /></td>
                          <td className="sw-num">
                            <Figure minor={f.currentMinor} zero="zero" colour={false} />
                            {!f.splitPosted && f.status === "active" && (
                              <span className="block text-[0.6875rem]" style={{ color: "var(--sw-warn)" }}>not posted</span>
                            )}
                          </td>
                          <td>
                            <StatusChip status={f.status} />
                            {f.covenants > 0 && (
                              <span className="sw-chip ml-1">{f.covenants} cov</span>
                            )}
                          </td>
                          <td>
                            <div className="flex flex-wrap items-center gap-1.5">
                              {f.status === "draft" && (
                                <button
                                  type="button" className="sw-link-btn" disabled={busy === `draw:${f.code}`}
                                  onClick={async () => {
                                    const r = await act(`draw:${f.code}`, { action: "draw", code: f.code });
                                    if (!r) return;
                                    setMsg(r.alreadyDrawn
                                      ? `${f.code} was already drawn — nothing posted (${r.reference}).`
                                      : `Drew ${f.code} as ${r.reference}. The bank is up and the liability recognised.`);
                                  }}
                                >
                                  draw
                                </button>
                              )}
                              {f.status === "active" && (
                                <button
                                  type="button" className="sw-link-btn" disabled={busy === `pay:${f.code}`}
                                  onClick={async () => {
                                    const r = await act(`pay:${f.code}`, {
                                      action: "instalment", code: f.code, instalmentNo: f.paidTo + 1,
                                    });
                                    if (!r) return;
                                    setMsg(r.alreadyPosted
                                      ? `Instalment ${f.paidTo + 1} of ${f.code} was already posted (${r.reference}).`
                                      : `Posted instalment ${r.instalmentNo} of ${f.code} as ${r.reference}.`);
                                  }}
                                >
                                  post instalment {f.paidTo + 1}
                                </button>
                              )}
                              <button
                                type="button" className="sw-link-btn" aria-expanded={open === f.code}
                                onClick={() => showSchedule(f.code)}
                              >
                                {open === f.code ? "hide" : "schedule"}
                              </button>
                            </div>
                          </td>
                        </tr>

                        {open === f.code && (
                          <tr>
                            <td colSpan={10} style={{ background: "var(--sw-ground)" }}>
                              {!schedule ? (
                                <Loading label="Building the schedule…" />
                              ) : (
                                <ScheduleTable schedule={schedule} />
                              )}
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <th scope="row" colSpan={6} style={{ textAlign: "start" }}>Total</th>
                      <td className="sw-num"><Figure minor={data.totals.outstandingMinor} zero="zero" /></td>
                      <td className="sw-num"><Figure minor={data.totals.currentMinor} zero="zero" /></td>
                      <td colSpan={2} />
                    </tr>
                  </tfoot>
                </table>
              </div>
            </Panel>
          )}

          {/* ──────────────────────────────────── the IFRS 7 maturity note */}
          <Panel className="mb-4 p-4">
            <div className="sw-label">Maturity of the borrowings — IFRS 7.39(a)</div>
            <div className="sw-scroll">
              <table className="sw-table mt-3" style={{ minWidth: "40rem" }}>
                <caption className="sr-only">
                  Contractual undiscounted cash flows on the borrowings, by the period remaining to maturity
                </caption>
                <thead>
                  <tr>
                    <th>Falling due</th>
                    <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Principal</th>
                    <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Interest</th>
                    <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Cash flow</th>
                  </tr>
                </thead>
                <tbody data-testid="maturity-bands">
                  {data.maturity.bands.map((b) => (
                    <tr key={b.band}>
                      <th scope="row" style={{ textAlign: "start" }}>{b.label}</th>
                      <td className="sw-num"><Figure minor={b.principalMinor} zero="zero" colour={false} /></td>
                      <td className="sw-num"><Figure minor={b.interestMinor} zero="zero" colour={false} /></td>
                      <td className="sw-num"><Figure minor={b.cashFlowMinor} zero="zero" colour={false} /></td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <th scope="row" style={{ textAlign: "start" }}>Contractual cash flows, undiscounted</th>
                    <td className="sw-num"><Figure minor={data.maturity.totals.principalMinor} zero="zero" /></td>
                    <td className="sw-num"><Figure minor={data.maturity.totals.interestMinor} zero="zero" /></td>
                    <td className="sw-num" data-testid="maturity-total">
                      <Figure minor={data.maturity.totals.cashFlowMinor} zero="zero" />
                    </td>
                  </tr>
                  <tr>
                    <th scope="row" colSpan={3} style={{ textAlign: "start" }}>
                      Less interest not yet accrued
                    </th>
                    <td className="sw-num">
                      <Figure minor={`-${data.maturity.differenceMinor}`} zero="zero" />
                    </td>
                  </tr>
                  <tr>
                    <th scope="row" colSpan={3} style={{ textAlign: "start" }}>
                      Carrying amount on the balance sheet
                    </th>
                    <td className="sw-num" data-testid="maturity-carrying">
                      <Figure minor={data.maturity.carryingAmountMinor} zero="zero" />
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
            <p className="sw-sub mt-2 max-w-[75ch]">
              <strong>These figures do not agree with the balance sheet, and are not meant to.</strong>{" "}
              IFRS 7.B11D asks for the contractual cash flows undiscounted, so the total above is every dirham that
              will leave the bank between {data.asOf} and the last instalment — principal and interest together.
              The balance sheet carries what is owed today. The whole of the difference is interest that has not
              accrued yet; discount these cash flows at each facility&rsquo;s effective rate and you get the
              carrying amount back. It is set out as a subtraction here because it is the question this note
              produces more often than any other.
            </p>
          </Panel>

          {/* ────────────────────────────────────────────────── covenants */}
          <Panel className="mb-4 p-4">
            <div className="sw-label">Covenants</div>
            {covenants.error && <ErrorNote>{covenants.error}</ErrorNote>}
            {covenants.data && covenants.data.tests.length === 0 ? (
              <p className="sw-sub mt-2 max-w-[75ch]">
                No covenant is recorded against any facility. That is not the same as there being none — it means
                nobody has written them down here, so nothing on this screen can tell you whether they are met.
              </p>
            ) : covenants.data ? (
              <>
                <div className="sw-scroll">
                  <table className="sw-table mt-3" style={{ minWidth: "44rem" }}>
                    <caption className="sr-only">
                      Covenants recorded against the facilities, tested against the books at {covenants.data.asOf}
                    </caption>
                    <thead>
                      <tr>
                        <th style={{ width: "6rem" }}>Facility</th>
                        <th style={{ width: "7rem" }}>Covenant</th>
                        <th>Test</th>
                        <th className="sw-num" style={{ width: "6rem" }}>Threshold</th>
                        <th className="sw-num" style={{ width: "6rem" }}>Actual</th>
                        <th style={{ width: "7rem" }}>Result</th>
                      </tr>
                    </thead>
                    <tbody data-testid="covenant-rows">
                      {covenants.data.tests.map((t) => (
                        <tr key={`${t.borrowingCode}:${t.code}`}>
                          <td className="sw-code">{t.borrowingCode}</td>
                          <td className="sw-code">{t.code}</td>
                          <td>
                            {t.label}
                            <span className="block sw-sub">{t.wording ?? t.why}</span>
                          </td>
                          <td className="sw-num">
                            {t.unit === "ratio" && t.thresholdBps !== null
                              ? `${t.direction === "MIN" ? "≥" : "≤"} ${ratio(t.thresholdBps)}`
                              : t.unit === "amount" && t.thresholdMinor !== null
                                ? <><span aria-hidden="true">{t.direction === "MIN" ? "≥ " : "≤ "}</span><Figure minor={t.thresholdMinor} colour={false} /></>
                                : <span className="sw-zero">–</span>}
                          </td>
                          <td className="sw-num">
                            {t.actualBps !== null
                              ? ratio(t.actualBps)
                              : t.actualMinor !== null
                                ? <Figure minor={t.actualMinor} colour={false} />
                                : <span className="sw-zero">–</span>}
                          </td>
                          <td>
                            <span className={RESULT_CHIP[t.result]}>{RESULT_WORD[t.result]}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="sw-sub mt-2 max-w-[75ch]" data-testid="covenant-note">{covenants.data.note}</p>
                <p className="sw-sub mt-2 max-w-[75ch]">
                  A covenant this ledger cannot measure is shown as not tested, never as met. Testing it against a
                  figure somebody typed in would only test the typing, and one false green makes the rest of this
                  table worthless.
                </p>
              </>
            ) : (
              <Loading label="Testing the covenants…" />
            )}
          </Panel>

          <p className="sw-sub mt-3 max-w-[75ch]">
            Nothing here nets an arrangement fee off the principal, and IFRS 9.5.1.1 would: a facility with fees has
            an effective rate above the one reported, and the fee needs its own journal. A floating rate is not
            modelled either — the schedule is fixed at drawdown, and a rate that moves is a new schedule rather than
            a recomputed one.
          </p>
        </>
      )}
    </>
  );
}

/* ------------------------------------------------------------ the schedule */

function ScheduleTable({ schedule }: { schedule: Schedule }) {
  return (
    <div style={{ margin: "0.5rem" }}>
      <p className="sw-sub max-w-[75ch]">{schedule.note}</p>
      <dl className="mt-2 flex flex-wrap gap-x-6 gap-y-2">
        <div>
          <dt className="sw-label">Quoted rate</dt>
          <dd className="sw-num">{pct(schedule.statedRateBps)} a year</dd>
        </div>
        <div>
          <dt className="sw-label">Effective rate — IFRS 9</dt>
          <dd className="sw-num">{pct(schedule.effectiveRateBps)} a year</dd>
        </div>
        <div>
          <dt className="sw-label">Instalment</dt>
          <dd className="sw-num"><Figure minor={schedule.instalmentMinor} colour={false} /></dd>
        </div>
        <div>
          <dt className="sw-label">Interest over the term</dt>
          <dd className="sw-num"><Figure minor={schedule.totals.interestMinor} colour={false} /></dd>
        </div>
        {schedule.flatInterestMinor !== null && (
          <div>
            <dt className="sw-label">Flat interest quoted</dt>
            <dd className="sw-num"><Figure minor={schedule.flatInterestMinor} colour={false} /></dd>
          </div>
        )}
      </dl>
      <div className="sw-scroll">
        <table className="sw-table mt-2" style={{ minWidth: "44rem" }}>
          <caption className="sr-only">Amortisation schedule for facility {schedule.code}</caption>
          <thead>
            <tr>
              <th className="sw-num" style={{ width: "3rem" }}>#</th>
              <th style={{ width: "7rem" }}>Due</th>
              <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Opening</th>
              <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Interest</th>
              <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Principal</th>
              <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Instalment</th>
              <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Closing</th>
              <th style={{ width: "5rem" }} />
            </tr>
          </thead>
          <tbody data-testid="schedule-rows">
            {schedule.rows.map((r) => (
              <tr key={r.instalmentNo}>
                <td className="sw-num">{r.instalmentNo}</td>
                <td>{r.dueOn}</td>
                <td className="sw-num"><Figure minor={r.openingMinor} colour={false} /></td>
                <td className="sw-num"><Figure minor={r.interestMinor} colour={false} /></td>
                <td className="sw-num"><Figure minor={r.principalMinor} colour={false} /></td>
                <td className="sw-num"><Figure minor={r.instalmentMinor} colour={false} /></td>
                <td className="sw-num"><Figure minor={r.closingMinor} zero="zero" colour={false} /></td>
                <td>{r.posted && <span className="sw-chip sw-chip-ok">posted</span>}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row" colSpan={3} style={{ textAlign: "start" }}>Over the whole term</th>
              <td className="sw-num"><Figure minor={schedule.totals.interestMinor} /></td>
              <td className="sw-num"><Figure minor={schedule.totals.principalMinor} /></td>
              <td className="sw-num"><Figure minor={schedule.totals.cashMinor} /></td>
              <td className="sw-num"><Figure minor="0" zero="zero" /></td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="sw-sub mt-2 max-w-[75ch]">
        The closing balance is exactly nil, not nearly nil. Rounding the instalment to the fil leaves a few minor
        units over the term, and they go into the last instalment — which is what a lender does too, because the
        final payment is a settlement figure. The principal column adds back to the amount advanced.
      </p>
    </div>
  );
}

/* ----------------------------------------------------------- the new facility */

function NewFacility({ busy, onAdd }: {
  busy: boolean;
  onAdd: (b: {
    code: string; lender: string; principalMinor: string; currency: string;
    drawdownOn: string; statedRateBps: number; interestBasis: string;
    frequency: string; termMonths: number; notes?: string;
  }) => void;
}) {
  const [code, setCode] = React.useState("");
  const [lender, setLender] = React.useState("");
  const [principal, setPrincipal] = React.useState("");
  const [currency, setCurrency] = React.useState("AED");
  const [drawdownOn, setDrawdownOn] = React.useState(today);
  const [rate, setRate] = React.useState("");
  const [basis, setBasis] = React.useState("REDUCING");
  const [frequency, setFrequency] = React.useState("MONTHLY");
  const [term, setTerm] = React.useState("36");
  const [notes, setNotes] = React.useState("");
  const [err, setErr] = React.useState<string | null>(null);

  return (
    <Panel className="mb-4 p-4">
      <div className="sw-label">A new facility</div>
      <div className="mt-3 grid gap-3 sm:grid-cols-4">
        <label className="block">
          <span className="sw-label">Code</span>
          <input className="sw-input mt-1" value={code} onChange={(e) => setCode(e.target.value)}
            placeholder="BRW-1" aria-label="Facility code" />
        </label>
        <label className="block">
          <span className="sw-label">Lender</span>
          <input className="sw-input mt-1" value={lender} onChange={(e) => setLender(e.target.value)}
            aria-label="Lender" />
        </label>
        <label className="block">
          <span className="sw-label">Principal advanced</span>
          <input className="sw-input sw-num mt-1" value={principal} placeholder="0.00"
            onChange={(e) => setPrincipal(e.target.value)} aria-label="Principal advanced" />
        </label>
        <label className="block">
          <span className="sw-label">Currency</span>
          <input className="sw-input mt-1" value={currency} onChange={(e) => setCurrency(e.target.value)}
            aria-label="Currency of the facility" />
        </label>
        <label className="block">
          <span className="sw-label">Drawn on</span>
          <input type="date" className="sw-input mt-1" value={drawdownOn}
            onChange={(e) => setDrawdownOn(e.target.value)} aria-label="Date the facility is drawn" />
        </label>
        <label className="block">
          <span className="sw-label">Rate a year, quoted</span>
          <input className="sw-input sw-num mt-1" value={rate} placeholder="5.00"
            onChange={(e) => setRate(e.target.value)} aria-label="Interest rate a year as quoted, in percent" />
        </label>
        <label className="block">
          <span className="sw-label">Charged on</span>
          <select className="sw-select mt-1" value={basis} onChange={(e) => setBasis(e.target.value)}
            aria-label="Whether interest is charged on the reducing balance or at a flat rate">
            <option value="REDUCING">the reducing balance</option>
            <option value="FLAT">the original sum — flat</option>
          </select>
        </label>
        <label className="block">
          <span className="sw-label">Repaid</span>
          <select className="sw-select mt-1" value={frequency} onChange={(e) => setFrequency(e.target.value)}
            aria-label="How often the facility is repaid">
            <option value="MONTHLY">monthly</option>
            <option value="QUARTERLY">quarterly</option>
            <option value="SEMIANNUAL">half-yearly</option>
            <option value="ANNUAL">yearly</option>
          </select>
        </label>
        <label className="block">
          <span className="sw-label">Term, months</span>
          <input className="sw-input sw-num mt-1" value={term} onChange={(e) => setTerm(e.target.value)}
            aria-label="Term of the facility in months" />
        </label>
        <label className="block sm:col-span-3">
          <span className="sw-label">Note</span>
          <input className="sw-input mt-1" value={notes} onChange={(e) => setNotes(e.target.value)}
            placeholder="optional" aria-label="Note about the facility" />
        </label>
      </div>

      <p className="sw-sub mt-3 max-w-[75ch]">
        A flat rate is charged on the whole of the sum originally advanced for the whole of the term, whatever has
        been repaid. Record it as flat and the effective rate — the one IFRS 9 measures at — is worked out and shown
        beside the quoted one. Recording a flat facility as reducing understates the finance cost of the early years
        and overstates it later.
      </p>

      {err && <div className="sw-error mt-2" role="alert">{err}</div>}

      <div className="mt-3">
        <button
          type="button" className="sw-btn sw-btn-primary" disabled={busy} data-testid="save-borrowing"
          onClick={() => {
            if (!code.trim() || !lender.trim()) { setErr("A facility needs a code and the lender it is owed to."); return; }
            const p = parseAmount(principal, currency.trim().toUpperCase() || "AED");
            if (p === null || p <= 0n) { setErr("The principal has to be an amount above nil."); return; }
            const r = Number(rate);
            if (!Number.isFinite(r) || r < 0 || r > 100) { setErr("The rate is a percentage between nil and 100."); return; }
            const bps = Math.round(r * 100);
            const months = Number(term);
            if (!Number.isInteger(months) || months <= 0) { setErr("The term is a whole number of months above nil."); return; }
            setErr(null);
            onAdd({
              code: code.trim(), lender: lender.trim(),
              principalMinor: p.toString(), currency: currency.trim().toUpperCase() || "AED",
              drawdownOn, statedRateBps: bps, interestBasis: basis,
              frequency, termMonths: months, notes: notes.trim() || undefined,
            });
          }}
        >
          {busy ? "Saving…" : "Record the facility"}
        </button>
      </div>
    </Panel>
  );
}

/* ---------------------------------------------------------- the new covenant */

function NewCovenant({ busy, codes, onAdd }: {
  busy: boolean;
  codes: string[];
  onAdd: (c: {
    borrowingCode: string; code: string; metric: string; direction: string;
    thresholdBps?: number | null; thresholdMinor?: string | null; wording?: string;
  }) => void;
}) {
  const [facility, setFacility] = React.useState(codes[0] ?? "");
  const [code, setCode] = React.useState("");
  const [metric, setMetric] = React.useState("CURRENT_RATIO");
  const [direction, setDirection] = React.useState("MIN");
  const [threshold, setThreshold] = React.useState("");
  const [wording, setWording] = React.useState("");
  const [err, setErr] = React.useState<string | null>(null);

  const unit = metric === "MIN_NET_WORTH" ? "amount" : metric === "OTHER" ? "none" : "ratio";

  return (
    <Panel className="mb-4 p-4">
      <div className="sw-label">A covenant on a facility</div>
      <div className="mt-3 grid gap-3 sm:grid-cols-4">
        <label className="block">
          <span className="sw-label">Facility</span>
          <select className="sw-select mt-1" value={facility} onChange={(e) => setFacility(e.target.value)}
            aria-label="Facility the covenant belongs to">
            {codes.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="sw-label">Covenant code</span>
          <input className="sw-input mt-1" value={code} onChange={(e) => setCode(e.target.value)}
            placeholder="GEARING" aria-label="Covenant code" />
        </label>
        <label className="block">
          <span className="sw-label">What is measured</span>
          <select className="sw-select mt-1" value={metric} onChange={(e) => setMetric(e.target.value)}
            aria-label="What the covenant measures">
            <option value="CURRENT_RATIO">current ratio</option>
            <option value="DEBT_TO_EQUITY">debt to equity</option>
            <option value="INTEREST_COVER">interest cover</option>
            <option value="MIN_NET_WORTH">minimum net worth</option>
            <option value="OTHER">something this ledger cannot test</option>
          </select>
        </label>
        <label className="block">
          <span className="sw-label">Threshold is a</span>
          <select className="sw-select mt-1" value={direction} onChange={(e) => setDirection(e.target.value)}
            aria-label="Whether the threshold is a floor or a ceiling">
            <option value="MIN">floor — must be at least</option>
            <option value="MAX">ceiling — must not exceed</option>
          </select>
        </label>
        {unit !== "none" && (
          <label className="block">
            <span className="sw-label">{unit === "ratio" ? "Threshold, as a ratio" : "Threshold amount"}</span>
            <input className="sw-input sw-num mt-1" value={threshold} onChange={(e) => setThreshold(e.target.value)}
              placeholder={unit === "ratio" ? "1.25" : "0.00"}
              aria-label={unit === "ratio" ? "Threshold as a ratio" : "Threshold amount"} />
          </label>
        )}
        <label className="block sm:col-span-3">
          <span className="sw-label">What the facility letter says</span>
          <input className="sw-input mt-1" value={wording} onChange={(e) => setWording(e.target.value)}
            placeholder={unit === "none" ? "required" : "optional"}
            aria-label="What the covenant requires, in the lender's own words" />
        </label>
      </div>

      <p className="sw-sub mt-3 max-w-[75ch]">
        Only the first four can be measured from these books. Anything else is recorded so it is not forgotten and
        reported as not tested — never as met — because a covenant shown green that nobody checked is worse than one
        that was never written down.
      </p>

      {err && <div className="sw-error mt-2" role="alert">{err}</div>}

      <div className="mt-3">
        <button
          type="button" className="sw-btn sw-btn-primary" disabled={busy} data-testid="save-covenant"
          onClick={() => {
            if (!facility || !code.trim()) { setErr("A covenant needs the facility it belongs to and a code of its own."); return; }
            if (unit === "none" && !wording.trim()) {
              setErr("A covenant this ledger cannot test has to say what it actually requires."); return;
            }
            let thresholdBps: number | null = null;
            let thresholdMinor: string | null = null;
            if (unit === "ratio") {
              const v = Number(threshold);
              if (!Number.isFinite(v) || v < 0) { setErr("A ratio threshold is a number above nil, such as 1.25."); return; }
              thresholdBps = Math.round(v * 10_000);
            }
            if (unit === "amount") {
              const v = parseAmount(threshold, "AED");
              if (v === null) { setErr("The threshold has to be an amount I can read."); return; }
              thresholdMinor = v.toString();
            }
            setErr(null);
            onAdd({
              borrowingCode: facility, code: code.trim(), metric, direction,
              thresholdBps, thresholdMinor, wording: wording.trim() || undefined,
            });
          }}
        >
          {busy ? "Saving…" : "Record the covenant"}
        </button>
      </div>
    </Panel>
  );
}
