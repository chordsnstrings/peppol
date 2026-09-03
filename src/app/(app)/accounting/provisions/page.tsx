"use client";

import * as React from "react";
import Link from "next/link";
import { api, ApiError, useEntityId, useLedgerQuery } from "@/components/ledger/use-ledger";
import { Figure, PageHead, Panel, ErrorNote, Loading, Empty, StatusChip } from "@/components/ledger/primitives";
import { parseAmount, toInput } from "@/lib/ledger/format";

/**
 * Provisions and contingencies, IAS 37.
 *
 * The page is built around the one distinction the standard turns on: a
 * provision is on the balance sheet, a contingency is not. They are therefore
 * two panels with two headings and two totals, never one table with a column
 * that says which is which — a reader who skims a merged list will add the
 * figures up, and the sum of a liability and a disclosure is not a number that
 * means anything.
 *
 * Every operation that changes a provision is an accounting event with a date:
 * a remeasurement, an unwinding, a use, a release, a promotion. There is no
 * "edit" here for the same reason there is none in the API.
 */

type Kind = "PROVISION" | "CONTINGENT_LIABILITY" | "CONTINGENT_ASSET";
type Category = "LEGAL" | "WARRANTY" | "RESTRUCTURING" | "ONEROUS" | "DECOMMISSIONING" | "OTHER";

const CATEGORIES: { value: Category; label: string }[] = [
  { value: "LEGAL", label: "Legal claims" },
  { value: "WARRANTY", label: "Warranties" },
  { value: "RESTRUCTURING", label: "Restructuring" },
  { value: "ONEROUS", label: "Onerous contracts" },
  { value: "DECOMMISSIONING", label: "Decommissioning and restoration" },
  { value: "OTHER", label: "Other provisions" },
];

/**
 * What choosing each kind ASSERTS. Shown before anything is recorded, because
 * the software cannot test any of it — the person recording it is the test.
 */
const KIND_TESTS: Record<Kind, { label: string; posts: string; tests: string[] }> = {
  PROVISION: {
    label: "Provision — recognised",
    posts: "Posts Dr the expense, Cr 2150 at the discounted estimate.",
    tests: [
      "There is a present obligation from a past event (IAS 37.14(a)).",
      "An outflow of resources is probable — more likely than not (IAS 37.14(b), 37.23).",
      "The amount can be estimated reliably (IAS 37.14(c), 37.36).",
    ],
  },
  CONTINGENT_LIABILITY: {
    label: "Contingent liability — disclosed only",
    posts: "Posts nothing at all. It is disclosed in the note and stays off the balance sheet.",
    tests: [
      "The obligation is possible but not confirmed, or present but not reliably measurable (IAS 37.10).",
      "An outflow is not probable, so one of the IAS 37.14 conditions fails (IAS 37.27).",
      "The possibility of an outflow is not remote — otherwise nothing is disclosed either (IAS 37.86).",
    ],
  },
  CONTINGENT_ASSET: {
    label: "Contingent asset — disclosed only",
    posts: "Posts nothing at all, and never will.",
    tests: [
      "A possible asset from a past event whose existence a future event will confirm (IAS 37.10).",
      "An inflow of economic benefits is probable — the only condition for disclosing it (IAS 37.34).",
      "It is never recognised, because that could book income that is never realised (IAS 37.31).",
    ],
  },
};

interface Movement {
  seq: number;
  kind: "RECOGNISE" | "REMEASURE" | "UNWIND" | "UTILISE" | "RELEASE";
  movedOn: string;
  amountMinor: string;
  note: string | null;
  entryId: string | null;
}
interface RegisterProvision {
  code: string; name: string; category: Category; categoryLabel: string; kind: Kind;
  recognisedOn: string; expectedOn: string | null;
  estimateMinor: string; discountMinor: string; carryingMinor: string;
  discountRateBps: number; monthlyRateBps: number;
  accountCode: string; expenseAccount: string;
  status: string; note: string | null; recognised: boolean; basis: string;
  movements: Movement[];
}
interface Register {
  provisions: RegisterProvision[];
  contingencies: RegisterProvision[];
  totals: {
    carryingMinor: string; estimateMinor: string; discountMinor: string;
    contingentLiabilityMinor: string; contingentAssetMinor: string;
  };
  ledger: { accounts: string[]; balanceMinor: string; differenceMinor: string; agrees: boolean };
}
interface NoteRow {
  category: Category; label: string;
  openingMinor: string; additionsMinor: string; usedMinor: string;
  releasedMinor: string; unwoundMinor: string; closingMinor: string;
  provisions: { code: string; name: string; carryingMinor: string; expectedOn: string | null; status: string }[];
}
interface Disclosed {
  code: string; name: string; category: Category; label: string;
  estimateMinor: string; recognisedOn: string; expectedOn: string | null; note: string | null;
}
interface Note {
  asOf: string; from: string; periodLabel: string;
  rows: NoteRow[];
  totals: {
    openingMinor: string; additionsMinor: string; usedMinor: string;
    releasedMinor: string; unwoundMinor: string; closingMinor: string;
  };
  carryingPerRegisterMinor: string;
  agreesWithRegister: boolean;
  movementsAfterAsOf: number;
  contingentLiabilities: Disclosed[];
  contingentAssets: Disclosed[];
  narrative: string[];
}

type ActionKind = "remeasure" | "utilise" | "release" | "promote";

const today = () => new Date().toISOString().slice(0, 10);
const thisMonth = () => new Date().toISOString().slice(0, 7);
const pct = (bps: number) => `${(bps / 100).toFixed(2)}%`;
const MOVEMENT_LABEL: Record<Movement["kind"], string> = {
  RECOGNISE: "Recognised",
  REMEASURE: "Remeasured",
  UNWIND: "Discount unwound",
  UTILISE: "Used",
  RELEASE: "Released",
};

export default function ProvisionsPage() {
  const entityId = useEntityId();
  const [asOf, setAsOf] = React.useState(() => `${new Date().getUTCFullYear()}-12-31`);
  const [period, setPeriod] = React.useState(thisMonth);

  const reg = useLedgerQuery<Register>(entityId ? `/api/ledger/provisions?entityId=${entityId}` : null);
  const note = useLedgerQuery<Note>(
    entityId ? `/api/ledger/provisions?entityId=${entityId}&view=note&asOf=${asOf}` : null,
  );

  const [busy, setBusy] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [adding, setAdding] = React.useState(false);
  const [openCode, setOpenCode] = React.useState<string | null>(null);
  const [action, setAction] = React.useState<{ kind: ActionKind; code: string } | null>(null);

  const act = async (label: string, body: Record<string, unknown>) => {
    setBusy(label); setErr(null); setMsg(null);
    try {
      const r = await api<Record<string, unknown> & { message?: string }>("/api/ledger/provisions", {
        method: "POST", body: JSON.stringify({ entityId, ...body }),
      });
      reg.reload();
      note.reload();
      if (r.message) setMsg(r.message);
      return r;
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "That did not work.");
      return null;
    } finally {
      setBusy(null);
    }
  };

  if (!entityId) return <Loading label="Choosing an entity…" />;

  const data = reg.data;

  return (
    <>
      <PageHead
        title="Provisions and contingencies"
        sub={
          "IAS 37 recognises a provision only where there is a present obligation from a past event, an outflow is " +
          "probable, and the amount can be estimated reliably. Where any of the three fails it is a contingent " +
          "liability: disclosed, and never recognised. Nothing on this page posts a journal for a contingency."
        }
        actions={
          <>
            <label className="flex items-center gap-1.5">
              <span className="sw-label">Unwind month</span>
              <input
                type="month"
                className="sw-input"
                style={{ width: "9rem" }}
                value={period}
                onChange={(e) => setPeriod(e.target.value)}
                aria-label="Month to unwind the discount for"
              />
            </label>
            <label className="flex items-center gap-1.5">
              <span className="sw-label">Note at</span>
              <input
                type="date"
                className="sw-input"
                style={{ width: "10rem" }}
                value={asOf}
                onChange={(e) => setAsOf(e.target.value)}
                aria-label="Reporting date for the note"
              />
            </label>
            <button
              type="button"
              className="sw-btn sw-btn-primary"
              onClick={() => { setAdding((a) => !a); setAction(null); }}
              data-testid="toggle-add-provision"
            >
              {adding ? "Cancel" : "Record one"}
            </button>
          </>
        }
      />

      {err && <ErrorNote>{err}</ErrorNote>}
      {msg && <div className="sw-note mb-3" role="status" data-testid="provision-result">{msg}</div>}
      {reg.error && <ErrorNote>{reg.error}</ErrorNote>}

      {adding && (
        <RecordProvision
          busy={busy === "record"}
          onRecord={async (body) => {
            const r = await act("record", { action: "record", ...body });
            if (r) setAdding(false);
          }}
        />
      )}

      {reg.loading && !data && <Loading />}

      {data && (
        <>
          <Panel className="mb-4 p-4">
            <div className="sw-label">Register against the ledger</div>
            <table className="sw-table mt-3" style={{ maxWidth: "44rem" }}>
              <caption className="sr-only">The provision register against account 2150</caption>
              <thead>
                <tr>
                  <th />
                  <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Register</th>
                  <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Ledger</th>
                  <th style={{ width: "8rem" }} />
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row" style={{ textAlign: "start", fontWeight: 400 }}>Provisions carried</th>
                  <td className="sw-num" data-testid="register-carrying">
                    <Figure minor={data.totals.carryingMinor} zero="zero" colour={false} />
                  </td>
                  <td className="sw-num"><Figure minor={data.ledger.balanceMinor} zero="zero" colour={false} /></td>
                  <td>
                    <Link href="/accounting/accounts/2150" className="sw-link">2150</Link>{" "}
                    <span
                      className={`sw-chip ${data.ledger.agrees ? "sw-chip-ok" : "sw-chip-bad"}`}
                      data-testid="register-agrees"
                    >
                      {data.ledger.agrees ? "agrees" : "differs"}
                    </span>
                  </td>
                </tr>
                <tr>
                  <th scope="row" style={{ textAlign: "start", fontWeight: 400 }}>
                    Discount still to unwind
                    <span className="sw-sub"> · to 6360 over the remaining term</span>
                  </th>
                  <td className="sw-num"><Figure minor={data.totals.discountMinor} zero="zero" colour={false} /></td>
                  <td colSpan={2} />
                </tr>
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row" style={{ textAlign: "start" }}>Undiscounted best estimate</th>
                  <td className="sw-num"><Figure minor={data.totals.estimateMinor} zero="zero" colour={false} /></td>
                  <td colSpan={2} className="sw-sub">what is expected to be paid, not what is carried</td>
                </tr>
              </tfoot>
            </table>
            {!data.ledger.agrees && (
              <p className="sw-sub mt-2" style={{ color: "var(--sw-neg)" }}>
                The register and the ledger disagree by{" "}
                <Figure minor={data.ledger.differenceMinor} zero="zero" colour={false} />. That is a finding, not a
                display problem — something was posted to 2150 by hand, or a movement was recorded without its
                journal.
              </p>
            )}
            <p className="sw-sub mt-2 max-w-[74ch]">
              Only provisions are compared. A contingency never reaches 2150, which is precisely why it has to be
              listed somewhere a reader can see it.
            </p>
          </Panel>

          {/* ---------------------------------------------------- provisions */}
          <Panel className="mb-4 overflow-hidden">
            <div className="p-3 pb-0">
              <div className="sw-label">Provisions — recognised, on the balance sheet</div>
            </div>
            {data.provisions.length === 0 ? (
              <div className="p-3"><Empty>No provisions recognised yet.</Empty></div>
            ) : (
              <div className="sw-scroll mt-2">
                <table className="sw-table">
                  <caption className="sr-only">Provisions recognised under IAS 37.14</caption>
                  <thead>
                    <tr>
                      <th style={{ width: "7rem" }}>Code</th>
                      <th>Provision</th>
                      <th className="hidden md:table-cell" style={{ width: "11rem" }}>Dates</th>
                      <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Estimate</th>
                      <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Discount</th>
                      <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Carried</th>
                      <th style={{ width: "6rem" }}>Status</th>
                      <th style={{ width: "19rem" }} />
                    </tr>
                  </thead>
                  <tbody data-testid="provision-rows">
                    {data.provisions.map((p) => (
                      <tr key={p.code}>
                        <td className="sw-code">{p.code}</td>
                        <td className="max-w-0 truncate">
                          {p.name}
                          <span className="sw-sub"> · {p.categoryLabel}</span>
                        </td>
                        <td className="hidden md:table-cell" style={{ color: "var(--sw-fg-muted)" }}>
                          {p.recognisedOn}
                          <span className="block text-[0.6875rem]">
                            {p.expectedOn ? `settles ${p.expectedOn}` : "no settlement date"}
                            {p.discountRateBps > 0 && ` · ${pct(p.discountRateBps)} a year`}
                          </span>
                        </td>
                        <td className="sw-num"><Figure minor={p.estimateMinor} colour={false} /></td>
                        <td className="sw-num"><Figure minor={p.discountMinor} colour={false} /></td>
                        <td className="sw-num"><Figure minor={p.carryingMinor} zero="zero" colour={false} /></td>
                        <td><StatusChip status={p.status} /></td>
                        <td>
                          <div className="flex flex-wrap items-center gap-1.5">
                            {p.status === "open" && p.discountRateBps > 0 && (
                              <button
                                type="button"
                                className="sw-btn sw-btn-sm"
                                onClick={() => act(`unwind:${p.code}`, { action: "unwind", code: p.code, period })}
                                aria-disabled={busy === `unwind:${p.code}` || undefined}
                                disabled={busy === `unwind:${p.code}`}
                                title={`Unwind ${period}'s discount to finance cost 6360`}
                                data-testid={`unwind-${p.code}`}
                              >
                                Unwind {period}
                              </button>
                            )}
                            {p.status === "open" && (
                              <>
                                <button type="button" className="sw-btn sw-btn-sm"
                                  onClick={() => setAction({ kind: "remeasure", code: p.code })}
                                  data-testid={`remeasure-${p.code}`}>Remeasure</button>
                                <button type="button" className="sw-btn sw-btn-sm"
                                  onClick={() => setAction({ kind: "utilise", code: p.code })}
                                  data-testid={`utilise-${p.code}`}>Use</button>
                                <button type="button" className="sw-btn sw-btn-sm"
                                  onClick={() => setAction({ kind: "release", code: p.code })}
                                  data-testid={`release-${p.code}`}>Release</button>
                              </>
                            )}
                            <button
                              type="button"
                              className="sw-btn sw-btn-sm"
                              aria-expanded={openCode === p.code}
                              onClick={() => setOpenCode(openCode === p.code ? null : p.code)}
                              data-testid={`movements-${p.code}`}
                            >
                              {openCode === p.code ? "Hide" : `Movements (${p.movements.length})`}
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <th scope="row" colSpan={3} style={{ textAlign: "start" }}>Carried at 2150</th>
                      <td className="sw-num"><Figure minor={data.totals.estimateMinor} colour={false} /></td>
                      <td className="sw-num"><Figure minor={data.totals.discountMinor} zero="zero" colour={false} /></td>
                      <td className="sw-num"><Figure minor={data.totals.carryingMinor} zero="zero" colour={false} /></td>
                      <td colSpan={2} />
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
            <p className="sw-sub px-3 py-2" style={{ borderTop: "1px solid var(--sw-line)" }}>
              The discount unwinds as a finance cost to 6360 (IAS 37.60), not as a bigger estimate. Only expenditure
              the provision was originally made for may be charged against it (IAS 37.61).
            </p>
          </Panel>

          {/* -------------------------------------------------- contingencies */}
          <Panel className="mb-4 overflow-hidden">
            <div className="p-3 pb-0">
              <div className="sw-label">
                Contingencies — disclosed, never recognised
                <span className="sw-chip sw-chip-warn ml-2">not on the balance sheet</span>
              </div>
              <p className="sw-sub mt-1 max-w-[74ch]">
                These are a different thing from the provisions above and must never be read as one list. Nothing
                here has been posted: a contingent liability is disclosed because an outflow is not probable
                (IAS 37.27), and a contingent asset is never recognised at all (IAS 37.31). Recognise a contingent
                liability the day the outflow becomes probable — that is a promotion, and it carries its own date.
              </p>
            </div>
            {data.contingencies.length === 0 ? (
              <div className="p-3"><Empty>Nothing disclosed as a contingency.</Empty></div>
            ) : (
              <div className="sw-scroll mt-2">
                <table className="sw-table">
                  <caption className="sr-only">Contingent liabilities and contingent assets, disclosed under IAS 37.86 and 37.89</caption>
                  <thead>
                    <tr>
                      <th style={{ width: "7rem" }}>Code</th>
                      <th>Contingency</th>
                      <th style={{ width: "10rem" }}>Kind</th>
                      <th className="hidden md:table-cell" style={{ width: "9rem" }}>Disclosed from</th>
                      <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Estimate</th>
                      <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Carried</th>
                      <th style={{ width: "16rem" }} />
                    </tr>
                  </thead>
                  <tbody data-testid="contingency-rows">
                    {data.contingencies.map((c) => (
                      <tr key={c.code}>
                        <td className="sw-code">{c.code}</td>
                        <td className="max-w-0 truncate">
                          {c.name}
                          <span className="sw-sub"> · {c.categoryLabel}</span>
                        </td>
                        <td>
                          <span className="sw-chip sw-chip-warn">
                            {c.kind === "CONTINGENT_ASSET" ? "contingent asset" : "contingent liability"}
                          </span>
                        </td>
                        <td className="hidden md:table-cell" style={{ color: "var(--sw-fg-muted)" }}>{c.recognisedOn}</td>
                        <td className="sw-num"><Figure minor={c.estimateMinor} colour={false} /></td>
                        <td className="sw-num sw-zero">nil</td>
                        <td>
                          <div className="flex flex-wrap items-center gap-1.5">
                            <button type="button" className="sw-btn sw-btn-sm"
                              onClick={() => setAction({ kind: "remeasure", code: c.code })}
                              data-testid={`review-${c.code}`}>Review estimate</button>
                            {c.kind === "CONTINGENT_LIABILITY" && (
                              <button type="button" className="sw-btn sw-btn-sm sw-btn-primary"
                                onClick={() => setAction({ kind: "promote", code: c.code })}
                                data-testid={`promote-${c.code}`}>Recognise</button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <th scope="row" colSpan={4} style={{ textAlign: "start" }}>Disclosed, not recognised</th>
                      <td className="sw-num" data-testid="contingent-total">
                        <Figure
                          minor={(BigInt(data.totals.contingentLiabilityMinor) + BigInt(data.totals.contingentAssetMinor)).toString()}
                          zero="zero"
                          colour={false}
                        />
                      </td>
                      <td className="sw-num sw-zero">nil</td>
                      <td />
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </Panel>

          {action && (
            <ActionPanel
              action={action}
              provision={[...data.provisions, ...data.contingencies].find((p) => p.code === action.code)}
              busy={busy}
              onClose={() => setAction(null)}
              onSubmit={async (body) => {
                const r = await act(`${action.kind}:${action.code}`, { action: action.kind, code: action.code, ...body });
                if (r) setAction(null);
              }}
            />
          )}

          {openCode && (
            <MovementPanel
              provision={data.provisions.find((p) => p.code === openCode) ?? data.contingencies.find((p) => p.code === openCode)}
            />
          )}

          <NotePanel note={note.data} error={note.error} loading={note.loading} />
        </>
      )}
    </>
  );
}

/* ----------------------------------------------------------------- recording */

function RecordProvision({ busy, onRecord }: {
  busy: boolean;
  onRecord: (body: Record<string, unknown>) => void;
}) {
  const [f, setF] = React.useState({
    code: "", name: "", category: "OTHER" as Category, kind: "PROVISION" as Kind,
    recognisedOn: today(), estimate: "", rate: "0", expectedOn: "",
    expenseAccount: "6900", note: "",
  });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));

  const estimate = parseAmount(f.estimate);
  const ratePct = Number(f.rate);
  const bps = Number.isFinite(ratePct) ? Math.round(ratePct * 100) : NaN;
  const test = KIND_TESTS[f.kind];

  const blocker =
    !f.code.trim() ? "Give it a code." :
    !f.name.trim() ? "Name the obligation — the note asks what it is (IAS 37.85(a))." :
    estimate === null || estimate < 0n ? "What is the best estimate of the outflow?" :
    f.kind === "PROVISION" && estimate === 0n
      ? "A provision needs an amount. With no reliable estimate it is a contingent liability (IAS 37.26)." :
    !Number.isInteger(bps) || bps < 0 || bps > 10_000 ? "The discount rate is between 0% and 100%." :
    bps > 0 && !f.expectedOn ? "Discounting needs the date the outflow is expected (IAS 37.45)." :
    f.expectedOn && f.expectedOn < f.recognisedOn ? "The outflow cannot be expected before the obligation arose." :
    null;

  return (
    <Panel className="mb-4 p-4">
      <div className="sw-label">Record a provision or a contingency</div>
      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Code">
          <input className="sw-input" value={f.code} onChange={(e) => set("code", e.target.value)} placeholder="PR-001" />
        </Field>
        <Field label="Name">
          <input className="sw-input" value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="Warranty on the 2025 installations" />
        </Field>
        <Field label="What it is">
          <select className="sw-select" value={f.kind} onChange={(e) => set("kind", e.target.value as Kind)} data-testid="provision-kind">
            {(Object.keys(KIND_TESTS) as Kind[]).map((k) => (
              <option key={k} value={k}>{KIND_TESTS[k].label}</option>
            ))}
          </select>
        </Field>
        <Field label="Class">
          <select className="sw-select" value={f.category} onChange={(e) => set("category", e.target.value as Category)}>
            {CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
        </Field>
        <Field label="Arose on">
          <input type="date" className="sw-input" value={f.recognisedOn} onChange={(e) => set("recognisedOn", e.target.value)} />
        </Field>
        <Field label="Best estimate">
          <input className="sw-input sw-cell-num" inputMode="decimal" value={f.estimate}
            onChange={(e) => set("estimate", e.target.value)} placeholder="10,000.00" />
        </Field>
        <Field label="Discount rate (% a year)">
          <input className="sw-input sw-cell-num" inputMode="decimal" value={f.rate}
            onChange={(e) => set("rate", e.target.value)} placeholder="0" />
        </Field>
        <Field label="Outflow expected on">
          <input type="date" className="sw-input" value={f.expectedOn} onChange={(e) => set("expectedOn", e.target.value)} />
        </Field>
        <Field label="Charged to">
          <input className="sw-input" value={f.expenseAccount} onChange={(e) => set("expenseAccount", e.target.value)} placeholder="6900" />
        </Field>
        <Field label="Note">
          <input className="sw-input" value={f.note} onChange={(e) => set("note", e.target.value)} placeholder="Optional — the uncertainties (IAS 37.85(b))" />
        </Field>
      </div>

      <div className="mt-3 border-t pt-3" style={{ borderColor: "var(--sw-line)" }}>
        <div className="sw-label">What recording it this way asserts</div>
        <ul className="mt-1.5 space-y-0.5" data-testid="recognition-tests">
          {test.tests.map((t) => (
            <li key={t} className="sw-sub max-w-[80ch]">· {t}</li>
          ))}
        </ul>
        <p className="sw-sub mt-1.5 max-w-[80ch]" style={{ color: "var(--sw-fg)" }}>{test.posts}</p>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="sw-btn sw-btn-primary"
          aria-disabled={blocker !== null || busy || undefined}
          disabled={blocker !== null || busy}
          data-testid="save-provision"
          onClick={() => onRecord({
            code: f.code.trim(), name: f.name.trim(), category: f.category, kind: f.kind,
            recognisedOn: f.recognisedOn, estimateMinor: (estimate as bigint).toString(),
            discountRateBps: bps, expectedOn: f.expectedOn || null,
            expenseAccount: f.expenseAccount.trim() || undefined,
            note: f.note.trim() || undefined,
          })}
        >
          {busy ? "Recording…" : f.kind === "PROVISION" ? "Recognise it" : "Disclose it"}
        </button>
        {blocker && <span className="sw-sub" role="status" data-testid="provision-blocker">{blocker}</span>}
        {!blocker && estimate !== null && (
          <span className="sw-sub">
            {f.kind === "PROVISION"
              ? `Dr ${f.expenseAccount || "6900"}, Cr 2150${bps > 0 ? " at the discounted estimate" : ` ${toInput(estimate)}`}.`
              : `${toInput(estimate)} disclosed. Nothing posted.`}
          </span>
        )}
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------------- the operations */

function ActionPanel({ action, provision, busy, onClose, onSubmit }: {
  action: { kind: ActionKind; code: string };
  provision: RegisterProvision | undefined;
  busy: string | null;
  onClose: () => void;
  onSubmit: (body: Record<string, unknown>) => void;
}) {
  const [on, setOn] = React.useState(today());
  const [amount, setAmount] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [cashAccount, setCashAccount] = React.useState("1010");

  const amountMinor = parseAmount(amount);
  const carrying = provision ? BigInt(provision.carryingMinor) : 0n;
  const working = busy === `${action.kind}:${action.code}`;

  const copy: Record<ActionKind, { title: string; why: string; verb: string }> = {
    remeasure: {
      title: `Remeasure ${action.code}`,
      why: provision?.recognised
        ? "Reviewed at each reporting date and adjusted to the current best estimate (IAS 37.59). The difference " +
          "is posted in the period the estimate changed — the original charge is never restated. A remeasurement " +
          "to nil is a release, not a deletion."
        : "A contingency is assessed continually (IAS 37.30). Changing the estimate changes what is disclosed and " +
          "posts nothing.",
      verb: "Remeasure",
    },
    utilise: {
      title: `Charge expenditure against ${action.code}`,
      why: "Dr 2150, Cr the bank. Only expenditure for which the provision was originally recognised may be set " +
        "against it (IAS 37.61) — anything more is refused, because charging it here would hide this period's " +
        "cost inside an earlier year's provision.",
      verb: "Charge against it",
    },
    release: {
      title: `Release ${action.code}`,
      why: "Dr 2150, Cr the expense it was charged to. A provision is reversed where the outflow is no longer " +
        "probable (IAS 37.59), in the period the estimate changed. Say why: it is the first thing a reader asks.",
      verb: "Release it",
    },
    promote: {
      title: `Recognise ${action.code} as a provision`,
      why: "A contingent liability whose outflow has become probable is recognised from the date the change in " +
        "probability occurs (IAS 37.30). That date decides which year carries the charge, so it is asked for " +
        "rather than assumed.",
      verb: "Recognise from this date",
    },
  };
  const c = copy[action.kind];

  const blocker =
    action.kind === "remeasure" && (amountMinor === null || amountMinor < 0n) ? "What is the current best estimate?" :
    action.kind === "utilise" && (amountMinor === null || amountMinor <= 0n) ? "How much was spent?" :
    action.kind === "utilise" && amountMinor !== null && amountMinor > carrying
      ? `Only ${toInput(carrying)} is carried, and only what the provision was made for may be charged against it (IAS 37.61).` :
    action.kind === "release" && !reason.trim() ? "Say why it is being released." :
    null;

  return (
    <Panel className="mb-4 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="sw-label">{c.title}</div>
          <p className="sw-sub mt-1 max-w-[74ch]">{c.why}</p>
        </div>
        <button type="button" className="sw-btn sw-btn-sm" onClick={onClose}>Cancel</button>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label={action.kind === "promote" ? "Probable from" : "On"}>
          <input type="date" className="sw-input" value={on} onChange={(e) => setOn(e.target.value)}
            aria-label={`Date for the ${action.kind}`} />
        </Field>
        {action.kind === "remeasure" && (
          <Field label="Current best estimate">
            <input className="sw-input sw-cell-num" inputMode="decimal" value={amount}
              onChange={(e) => setAmount(e.target.value)} placeholder={toInput(provision?.estimateMinor ?? "0")}
              data-testid="remeasure-amount" />
          </Field>
        )}
        {action.kind === "utilise" && (
          <>
            <Field label="Amount spent">
              <input className="sw-input sw-cell-num" inputMode="decimal" value={amount}
                onChange={(e) => setAmount(e.target.value)} placeholder={toInput(carrying)}
                data-testid="utilise-amount" />
            </Field>
            <Field label="Paid from">
              <input className="sw-input" value={cashAccount} onChange={(e) => setCashAccount(e.target.value)} placeholder="1010" />
            </Field>
          </>
        )}
        {action.kind === "release" && (
          <Field label="Why">
            <input className="sw-input" value={reason} onChange={(e) => setReason(e.target.value)}
              placeholder="The claim was withdrawn" data-testid="release-reason" />
          </Field>
        )}
        {action.kind === "promote" && provision && (
          <Field label="Estimate to recognise">
            <span className="sw-num block pt-1"><Figure minor={provision.estimateMinor} colour={false} /></span>
          </Field>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="sw-btn sw-btn-primary"
          aria-disabled={blocker !== null || working || undefined}
          disabled={blocker !== null || working}
          data-testid={`submit-${action.kind}`}
          onClick={() => onSubmit(
            action.kind === "remeasure" ? { on, estimateMinor: (amountMinor as bigint).toString() } :
            action.kind === "utilise" ? { on, amountMinor: (amountMinor as bigint).toString(), cashAccount } :
            action.kind === "release" ? { on, reason: reason.trim() } :
            { on },
          )}
        >
          {working ? "Posting…" : c.verb}
        </button>
        {blocker && <span className="sw-sub" role="status" data-testid="action-blocker">{blocker}</span>}
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------------ the movements */

function MovementPanel({ provision }: { provision: RegisterProvision | undefined }) {
  if (!provision) return null;
  if (provision.movements.length === 0) {
    return (
      <Panel className="mb-4 p-4">
        <div className="sw-label">{provision.code} — movements</div>
        <p className="sw-sub mt-1 max-w-[74ch]">
          Nothing has moved, because nothing was recognised. {provision.basis}
        </p>
      </Panel>
    );
  }

  let running = 0n;
  return (
    <Panel className="mb-4 overflow-hidden">
      <div className="p-3 pb-0">
        <div className="sw-label">{provision.code} — movements</div>
        <p className="sw-sub mt-1 max-w-[74ch]">{provision.basis}</p>
      </div>
      <div className="sw-scroll mt-2">
        <table className="sw-table">
          <caption className="sr-only">Every movement on provision {provision.code}</caption>
          <thead>
            <tr>
              <th style={{ width: "3rem" }}>#</th>
              <th style={{ width: "7rem" }}>Date</th>
              <th style={{ width: "11rem" }}>What happened</th>
              <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Movement</th>
              <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Carried after</th>
              <th>Note</th>
            </tr>
          </thead>
          <tbody data-testid="movement-rows">
            {provision.movements.map((m) => {
              running += BigInt(m.amountMinor);
              return (
                <tr key={m.seq}>
                  <td className="sw-sub">{m.seq}</td>
                  <td>{m.movedOn}</td>
                  <td>{MOVEMENT_LABEL[m.kind]}</td>
                  <td className="sw-num"><Figure minor={m.amountMinor} /></td>
                  <td className="sw-num"><Figure minor={running.toString()} zero="zero" colour={false} /></td>
                  <td className="sw-sub max-w-0 truncate">{m.note ?? ""}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="sw-sub px-3 py-2" style={{ borderTop: "1px solid var(--sw-line)" }}>
        A released provision keeps its movements. They are the disclosure (IAS 37.84) — deleting the row would
        delete the only record that the charge was ever made.
      </p>
    </Panel>
  );
}

/* ------------------------------------------------------------------ the note */

function NotePanel({ note, error, loading }: { note: Note | null; error: string | null; loading: boolean }) {
  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (loading && !note) return <Loading label="Building the note…" />;
  if (!note) return null;

  return (
    <Panel className="mb-4 overflow-hidden">
      <div className="p-3 pb-0">
        <div className="sw-label">
          The note — movement in each class
          <span className="sw-sub"> · {note.from} to {note.asOf} ({note.periodLabel})</span>
        </div>
        <p className="sw-sub mt-1 max-w-[80ch]">
          IAS 37.84 asks for this by class, not by item: the carrying amount at the start and end of the period,
          what was added, what was used, what was reversed unused, and the increase from the passage of time. The
          five columns are signed against the carrying amount, so each row adds across to its closing balance.
        </p>
      </div>

      {note.rows.length === 0 ? (
        <div className="p-3"><Empty>No provision moved in this period.</Empty></div>
      ) : (
        <div className="sw-scroll mt-2">
          <table className="sw-table">
            <caption className="sr-only">Movement in provisions by class, IAS 37.84</caption>
            <thead>
              <tr>
                <th>Class</th>
                <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Opening</th>
                <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Additions</th>
                <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Used</th>
                <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Reversed unused</th>
                <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Unwinding</th>
                <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Closing</th>
              </tr>
            </thead>
            <tbody data-testid="note-rows">
              {note.rows.map((r) => (
                <tr key={r.category}>
                  <th scope="row" style={{ textAlign: "start", fontWeight: 400 }}>
                    {r.label}
                    {r.provisions.length > 0 && (
                      <span className="block text-[0.6875rem]" style={{ color: "var(--sw-fg-muted)" }}>
                        {r.provisions.map((p) => p.code).join(", ")}
                      </span>
                    )}
                  </th>
                  <td className="sw-num"><Figure minor={r.openingMinor} zero="zero" colour={false} /></td>
                  <td className="sw-num"><Figure minor={r.additionsMinor} zero="zero" colour={false} /></td>
                  <td className="sw-num"><Figure minor={r.usedMinor} zero="zero" /></td>
                  <td className="sw-num"><Figure minor={r.releasedMinor} zero="zero" /></td>
                  <td className="sw-num"><Figure minor={r.unwoundMinor} zero="zero" colour={false} /></td>
                  <td className="sw-num"><Figure minor={r.closingMinor} zero="zero" colour={false} /></td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row" style={{ textAlign: "start" }}>Total provisions</th>
                <td className="sw-num"><Figure minor={note.totals.openingMinor} zero="zero" colour={false} /></td>
                <td className="sw-num"><Figure minor={note.totals.additionsMinor} zero="zero" colour={false} /></td>
                <td className="sw-num"><Figure minor={note.totals.usedMinor} zero="zero" /></td>
                <td className="sw-num"><Figure minor={note.totals.releasedMinor} zero="zero" /></td>
                <td className="sw-num"><Figure minor={note.totals.unwoundMinor} zero="zero" colour={false} /></td>
                <td className="sw-num" data-testid="note-closing">
                  <Figure minor={note.totals.closingMinor} zero="zero" colour={false} />
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {!note.agreesWithRegister && (
        <p className="sw-sub px-3 pt-2 max-w-[80ch]">
          The note closes at <Figure minor={note.totals.closingMinor} zero="zero" colour={false} /> against{" "}
          <Figure minor={note.carryingPerRegisterMinor} zero="zero" colour={false} /> carried today.{" "}
          {note.movementsAfterAsOf > 0
            ? `${note.movementsAfterAsOf} movement${note.movementsAfterAsOf === 1 ? "" : "s"} fall after ${note.asOf}, which is why.`
            : "Nothing moved after the reporting date, so the two should agree — that difference is a finding."}
        </p>
      )}

      <div className="grid gap-4 p-3 lg:grid-cols-2">
        <Disclosures
          title="Contingent liabilities — disclosed, not recognised"
          empty="None to disclose (IAS 37.86)."
          rows={note.contingentLiabilities}
        />
        <Disclosures
          title="Contingent assets — never recognised"
          empty="None to disclose (IAS 37.34)."
          rows={note.contingentAssets}
        />
      </div>

      <div className="border-t p-3" style={{ borderColor: "var(--sw-line)" }}>
        {note.narrative.map((s, i) => (
          <p key={i} className="sw-sub max-w-[80ch]" style={{ marginBlockStart: i ? "0.5rem" : 0 }}>{s}</p>
        ))}
      </div>
    </Panel>
  );
}

function Disclosures({ title, empty, rows }: { title: string; empty: string; rows: Disclosed[] }) {
  return (
    <div>
      <div className="sw-label">{title}</div>
      {rows.length === 0 ? (
        <p className="sw-sub mt-1">{empty}</p>
      ) : (
        <table className="sw-table mt-2">
          <caption className="sr-only">{title}</caption>
          <thead>
            <tr>
              <th style={{ width: "7rem" }}>Code</th>
              <th>Nature of the obligation</th>
              <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Estimate</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.code}>
                <td className="sw-code">{r.code}</td>
                <td className="max-w-0 truncate">
                  {r.name}
                  <span className="sw-sub"> · {r.label}</span>
                  {r.note && <span className="block text-[0.6875rem]" style={{ color: "var(--sw-fg-muted)" }}>{r.note}</span>}
                </td>
                <td className="sw-num"><Figure minor={r.estimateMinor} colour={false} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
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
