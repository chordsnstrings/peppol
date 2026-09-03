"use client";

import * as React from "react";
import Link from "next/link";
import { useEntityId, useLedgerQuery } from "@/components/ledger/use-ledger";
import { Figure, PageHead, Panel, ErrorNote, Loading } from "@/components/ledger/primitives";

/* The wire shapes, mirroring `src/lib/server/ledger/equity.ts`. Amounts arrive
 * as decimal strings of minor units and are formatted by <Figure>; nothing on
 * this page turns money into a JavaScript number. */

interface Column { code: string; name: string; nameAr: string | null }
interface Row {
  key: string;
  label: string;
  kind: "balance" | "movement";
  cells: Record<string, string>;
  totalMinor: string;
  origin: "posted" | "derived" | "mixed";
  note: string;
}
interface Statement {
  fiscalYear: string;
  from: string;
  to: string;
  currency: string;
  closed: boolean;
  columns: Column[];
  opening: Row;
  movements: Row[];
  closing: Row;
  totalByColumnsMinor: string;
  totalByRowsMinor: string;
  foots: boolean;
  equityPerBalanceSheetMinor: string;
  reconciles: boolean;
  differenceMinor: string;
  profitForThePeriodMinor: string;
  warnings: string[];
}

type NoteState = "present" | "empty" | "requires_input";
interface NoteBase { number: number; key: string; title: string; basis: string; state: NoteState; statement: string }

interface PolicyNote extends NoteBase {
  key: "accounting_policies";
  functionalCurrency: string;
  presentationCurrency: string;
  policies: { key: string; label: string; policy: string; basis: string; evidence: string }[];
}
interface Movement {
  openingMinor: string;
  closingMinor: string;
  perBalanceSheetMinor: string;
  agrees: boolean;
}
interface PpeNote extends NoteBase {
  key: "property_plant_and_equipment";
  costAccounts: string[];
  accumulatedDepreciationAccount: string;
  cost: Movement & { additionsMinor: string; disposalsMinor: string };
  accumulatedDepreciation: Movement & { chargeMinor: string; releasedOnDisposalMinor: string };
  netBookValue: { openingMinor: string; closingMinor: string };
  register: {
    assets: number; costMinor: string; accumulatedMinor: string; netBookValueMinor: string;
    costAgrees: boolean; accumulatedAgrees: boolean;
  };
  byCategory: { category: string; count: number; costMinor: string; accumulatedMinor: string; netBookValueMinor: string }[];
}
interface LeaseNote extends NoteBase {
  key: "leases";
  rightOfUseAssets: Movement & { additionsMinor: string; depreciationMinor: string };
  liabilities: Movement & { additionsMinor: string; interestMinor: string; paymentsMinor: string };
  interestExpenseMinor: string;
  shortTermAndLowValueExpenseMinor: string;
  totalCashOutflowMinor: string;
  maturity: { key: string; label: string; amountMinor: string }[];
  exemptions: { code: string; name: string; reason: string; note: string; annualRentMinor: string }[];
  notDerivable: string[];
  leases: number;
}
interface Ageing {
  account: string;
  name: string;
  asOf: string;
  bands: { key: string; label: string; amountMinor: string }[];
  totalPerAgeingMinor: string;
  totalPerLedgerMinor: string;
  agrees: boolean;
  differenceMinor: string;
  openItems: number;
  oldestDays: number | null;
}
interface ReceivablesPayablesNote extends NoteBase {
  key: "trade_receivables_and_payables";
  receivables: Ageing;
  payables: Ageing;
  allowanceForDoubtfulDebtsMinor: string;
  netReceivablesMinor: string;
}
interface RevenueNote extends NoteBase {
  key: "revenue";
  byTaxTreatment: { taxCode: string | null; label: string; amountMinor: string; shareBps: number | null }[];
  byAccount: { code: string; name: string; nameAr: string | null; amountMinor: string }[];
  totalMinor: string;
  untaggedMinor: string;
  untaggedLines: number;
  agrees: boolean;
}
interface RelatedPartyNote extends NoteBase {
  key: "related_parties";
  account: { code: string; name: string; nameAr: string | null };
  openingMinor: string;
  closingMinor: string;
  movements: { key: string; label: string; amountMinor: string }[];
  postings: number;
  requiresInput: string[];
}
interface TaxNote extends NoteBase {
  key: "corporate_tax";
  chargePerLedgerMinor: string;
  payableClosingMinor: string;
  computedChargeMinor: string;
  accountingProfitPerComputationMinor: string;
  profitForThePeriodMinor: string;
  computationReadsClosedYear: boolean;
  taxableIncomeMinor: string;
  effectiveRateBps: string | null;
  reconciliation: { key: string; label: string; basis: string; amountMinor: string }[];
  reconciliationTotalMinor: string;
  foots: boolean;
  adjustments: { key: string; label: string; basis: string; amountMinor: string; origin: string }[];
  smallBusinessRelief: { elected: boolean; applied: boolean; eligible: boolean; reason: string };
  provisionPosted: boolean;
  provisionAgrees: boolean;
  warnings: string[];
}
interface RequiresInputNote extends NoteBase {
  key: "events_after_the_reporting_period" | "commitments_and_contingencies";
  requires: { key: string; question: string; basis: string }[];
}

type Note =
  | PolicyNote | PpeNote | LeaseNote | ReceivablesPayablesNote
  | RevenueNote | RelatedPartyNote | TaxNote | RequiresInputNote;

interface Payload {
  fiscalYear: string;
  from: string;
  to: string;
  currency: string;
  availableYears: { label: string; startsOn: string; endsOn: string; status: string }[];
  statement: Statement;
  notes: Note[];
}

/**
 * A note's state is three-valued on purpose, and the chips say which: a note
 * with nothing in it and a note nobody has filled in are different facts, and
 * a reader who cannot tell them apart is being told the second is the first.
 */
const STATE_CHIP: Record<NoteState, { label: string; className: string }> = {
  present: { label: "from the ledger", className: "sw-chip-accent" },
  empty: { label: "nothing to disclose", className: "" },
  requires_input: { label: "requires input", className: "sw-chip-warn" },
};

export default function EquityPage() {
  const entityId = useEntityId();
  const [year, setYear] = React.useState<string>("");
  const { data, error, loading } = useLedgerQuery<{ equity: Payload }>(
    entityId
      ? `/api/ledger/equity?entityId=${entityId}${year ? `&fiscalYear=${encodeURIComponent(year)}` : ""}`
      : null,
  );

  if (!entityId) return <Loading label="Choosing an entity…" />;
  const eq = data?.equity;
  const st = eq?.statement;

  return (
    <>
      <PageHead
        title="Changes in equity, and the notes"
        sub="The fourth statement (IAS 1.106) and the disclosure notes, both derived from the ledger every time they are asked for. A note that is typed in by hand is a note that stops agreeing with the accounts."
        actions={
          <label className="flex items-center gap-1.5">
            <span className="sw-label">Fiscal year</span>
            <select
              className="sw-select"
              style={{ width: "9.5rem" }}
              value={year || eq?.fiscalYear || ""}
              onChange={(e) => setYear(e.target.value)}
              disabled={!eq}
            >
              {(eq?.availableYears ?? []).map((y) => (
                <option key={y.label} value={y.label}>
                  {y.label} — {y.status}
                </option>
              ))}
            </select>
          </label>
        }
      />

      {error && <ErrorNote>{error}</ErrorNote>}
      {loading && <Loading label="Reading the ledger…" />}

      {eq && st && (
        <div className="grid gap-4">
          <Panel className="overflow-hidden">
            <Head>
              Statement of changes in equity for {st.from} to {st.to}
            </Head>
            <div className="sw-scroll">
              <table className="sw-table">
                <caption className="sr-only">
                  Statement of changes in equity for the year {st.fiscalYear}. Movements down the side, equity
                  accounts across the top; the row totals and the column totals come to the same figure.
                </caption>
                <thead>
                  <tr>
                    <th scope="col" style={{ minWidth: "18rem" }}>Movement</th>
                    {st.columns.map((c) => (
                      <th key={c.code} scope="col" className="sw-num" style={{ width: "var(--sw-col-amount)" }}>
                        <span className="sw-code">{c.code}</span> {c.name}
                      </th>
                    ))}
                    <th scope="col" className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Total</th>
                  </tr>
                </thead>
                <tbody>
                  <MatrixRow row={st.opening} columns={st.columns} currency={st.currency} strong />
                  {st.movements.map((r) => (
                    <MatrixRow key={r.key} row={r} columns={st.columns} currency={st.currency} />
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <th scope="row">
                      {st.closing.label} at {st.to}
                    </th>
                    {st.columns.map((c) => (
                      <td key={c.code} className="sw-num" data-testid={`closing-${c.code}`}>
                        <Figure minor={st.closing.cells[c.code]} currency={st.currency} zero="zero" colour={false} />
                      </td>
                    ))}
                    <td className="sw-num" data-testid="closing-total">
                      <Figure minor={st.totalByColumnsMinor} currency={st.currency} zero="zero" colour={false} />
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>

            <div className="grid gap-2 px-3 py-2" style={{ borderTop: "1px solid var(--sw-line)" }}>
              <p className="sw-sub" data-testid="foot-note">
                Added down the columns the matrix comes to{" "}
                <Figure minor={st.totalByColumnsMinor} currency={st.currency} zero="zero" colour={false} />; added
                across the rows it comes to{" "}
                <Figure minor={st.totalByRowsMinor} currency={st.currency} zero="zero" colour={false} />.{" "}
                {st.foots ? "The two agree." : "They do not agree, which is a defect — please report it."}
              </p>
              <p className="sw-sub" role="status" aria-live="polite" data-testid="reconcile-state">
                {st.reconciles ? (
                  <>
                    Closing equity of{" "}
                    <Figure minor={st.totalByColumnsMinor} currency={st.currency} zero="zero" colour={false} /> is
                    exactly the equity section of the balance sheet at {st.to}. The closing figures above are built
                    up from the opening position and the movements, not read back off that sheet, so this is a check
                    rather than a restatement.{" "}
                    {st.closed
                      ? "The year has been closed, so the result is the credit the closing entry made to retained earnings."
                      : "The year is still open, so the result is not posted anywhere yet — it is what is left in the income and expense accounts."}
                  </>
                ) : (
                  <>
                    This statement does not reconcile. Equity closes at{" "}
                    <Figure minor={st.totalByColumnsMinor} currency={st.currency} zero="zero" colour={false} /> here
                    and at{" "}
                    <Figure minor={st.equityPerBalanceSheetMinor} currency={st.currency} zero="zero" colour={false} />{" "}
                    on the balance sheet, a difference of{" "}
                    <Figure minor={st.differenceMinor} currency={st.currency} zero="zero" />. The difference is left
                    on the face of the statement rather than absorbed into a balancing line — see the notes beside
                    it, then <Link href="/accounting/journals" className="sw-link">check the journals</Link> for the
                    account named.
                  </>
                )}
              </p>
            </div>
          </Panel>

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <Panel className="overflow-hidden">
              <Head>Reconciliation</Head>
              <div className="sw-scroll">
                <table className="sw-table">
                  <caption className="sr-only">Closing equity per this statement against the balance sheet</caption>
                  <tbody>
                    <tr>
                      <th scope="row" style={{ fontWeight: 400 }}>Per this statement</th>
                      <td className="sw-num">
                        <Figure minor={st.totalByColumnsMinor} currency={st.currency} zero="zero" />
                      </td>
                    </tr>
                    <tr>
                      <th scope="row" style={{ fontWeight: 400 }}>Per the balance sheet at {st.to}</th>
                      <td className="sw-num">
                        <Figure minor={st.equityPerBalanceSheetMinor} currency={st.currency} zero="zero" />
                      </td>
                    </tr>
                    <tr>
                      <th scope="row" style={{ fontWeight: 600, borderTop: "1px solid var(--sw-line-strong)" }}>
                        Difference
                      </th>
                      <td
                        className="sw-num"
                        data-testid="reconcile-difference"
                        style={{ fontWeight: 600, borderTop: "1px solid var(--sw-line-strong)" }}
                      >
                        <Figure minor={st.differenceMinor} currency={st.currency} zero="zero" />
                      </td>
                    </tr>
                    <tr>
                      <th scope="row" style={{ fontWeight: 400 }}>Result for the year</th>
                      <td className="sw-num">
                        <Figure minor={st.profitForThePeriodMinor} currency={st.currency} zero="zero" />
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </Panel>

            {st.warnings.length > 0 ? (
              <Panel className="overflow-hidden">
                <Head>Before you rely on this</Head>
                <ul className="grid gap-2 px-3 py-2" data-testid="equity-warnings">
                  {st.warnings.map((w, i) => (
                    <li key={i} className="sw-sub" style={{ color: "var(--sw-neg)" }}>{w}</li>
                  ))}
                </ul>
              </Panel>
            ) : (
              <Panel className="overflow-hidden">
                <Head>Before you rely on this</Head>
                <p className="sw-sub px-3 py-2">
                  Nothing to raise. Every movement in equity in {st.fiscalYear} has been classified, and every equity
                  account on the balance sheet is a column above.
                </p>
              </Panel>
            )}
          </div>

          <section aria-labelledby="notes-heading" className="grid gap-4">
            <h2 id="notes-heading" className="sw-title" style={{ fontSize: "1.05rem" }}>
              Notes to the financial statements
            </h2>
            {eq.notes.map((n) => (
              <NotePanel key={n.key} note={n} currency={st.currency} />
            ))}
          </section>
        </div>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ chrome */

function Head({ children }: { children: React.ReactNode }) {
  return (
    <div className="border-b px-3 py-2" style={{ borderColor: "var(--sw-line)", background: "var(--sw-surface-2)" }}>
      <span className="sw-label">{children}</span>
    </div>
  );
}

/** A row of the matrix. The note under the label says why the row is there. */
function MatrixRow({
  row, columns, currency, strong = false,
}: { row: Row; columns: Column[]; currency: string; strong?: boolean }) {
  return (
    <tr data-testid={`row-${row.key}`}>
      <th scope="row" style={{ fontWeight: strong || row.kind === "balance" ? 600 : 400, verticalAlign: "top", paddingBlock: "0.35rem" }}>
        {row.label}
        {row.origin !== "posted" && (
          <span className="sw-chip ms-2" style={{ verticalAlign: "middle" }}>
            {row.origin === "derived" ? "derived" : "part posted"}
          </span>
        )}
        <div className="sw-sub" style={{ maxWidth: "48ch", fontWeight: 400 }}>{row.note}</div>
      </th>
      {columns.map((c) => (
        <td key={c.code} className="sw-num" style={{ verticalAlign: "top", paddingBlock: "0.35rem" }}>
          <Figure minor={row.cells[c.code]} currency={currency} />
        </td>
      ))}
      <td className="sw-num" style={{ verticalAlign: "top", paddingBlock: "0.35rem", fontWeight: 600 }}>
        <Figure minor={row.totalMinor} currency={currency} zero="zero" />
      </td>
    </tr>
  );
}

function NotePanel({ note, currency }: { note: Note; currency: string }) {
  const chip = STATE_CHIP[note.state];
  return (
    <Panel className="overflow-hidden">
      <div
        className="flex flex-wrap items-baseline gap-2 border-b px-3 py-2"
        style={{ borderColor: "var(--sw-line)", background: "var(--sw-surface-2)" }}
      >
        <span className="sw-label">Note {note.number}</span>
        <h3 style={{ fontSize: "0.875rem", fontWeight: 600 }}>{note.title}</h3>
        <span className={`sw-chip ${chip.className}`}>{chip.label}</span>
        <span className="sw-sub ms-auto">{note.basis}</span>
      </div>
      <p className="sw-sub px-3 py-2" style={{ maxWidth: "80ch" }}>{note.statement}</p>
      <NoteBody note={note} currency={currency} />
    </Panel>
  );
}

function NoteBody({ note, currency }: { note: Note; currency: string }) {
  switch (note.key) {
    case "accounting_policies": return <PolicyBody note={note} />;
    case "property_plant_and_equipment": return <PpeBody note={note} currency={currency} />;
    case "leases": return <LeaseBody note={note} currency={currency} />;
    case "trade_receivables_and_payables": return <TradeBody note={note} currency={currency} />;
    case "revenue": return <RevenueBody note={note} currency={currency} />;
    case "related_parties": return <RelatedBody note={note} currency={currency} />;
    case "corporate_tax": return <TaxBody note={note} currency={currency} />;
    default: return <RequiresInputBody note={note} />;
  }
}

/* ------------------------------------------------------------- note bodies */

function PolicyBody({ note }: { note: PolicyNote }) {
  return (
    <dl className="grid gap-3 px-3 pb-3">
      {note.policies.map((p) => (
        <div key={p.key}>
          <dt style={{ fontWeight: 600, fontSize: "0.8125rem" }}>{p.label}</dt>
          <dd style={{ fontSize: "0.8125rem", lineHeight: 1.5, maxWidth: "80ch" }}>
            {p.policy}
            <div className="sw-sub">
              {p.basis} · {p.evidence}
            </div>
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** A movement table: opening, what happened, closing, and the ledger beside it. */
function MovementTable({
  caption, rows, closing, perLedger, agrees, currency, testId,
}: {
  caption: string;
  rows: { label: string; minor: string }[];
  closing: { label: string; minor: string };
  perLedger: string;
  agrees: boolean;
  currency: string;
  testId: string;
}) {
  return (
    <div className="sw-scroll">
      <table className="sw-table" data-testid={testId}>
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">{caption}</th>
            <th scope="col" className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Amount</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label}>
              <th scope="row" style={{ fontWeight: 400 }}>{r.label}</th>
              <td className="sw-num"><Figure minor={r.minor} currency={currency} /></td>
            </tr>
          ))}
          <tr>
            <th scope="row" style={{ fontWeight: 600 }}>{closing.label}</th>
            <td className="sw-num" style={{ fontWeight: 600 }}>
              <Figure minor={closing.minor} currency={currency} zero="zero" colour={false} />
            </td>
          </tr>
          <tr>
            <th scope="row" style={{ fontWeight: 400 }}>
              Per the balance sheet
              <span className={`sw-chip ms-2 ${agrees ? "sw-chip-ok" : "sw-chip-bad"}`}>
                {agrees ? "agrees" : "does not agree"}
              </span>
            </th>
            <td className="sw-num"><Figure minor={perLedger} currency={currency} zero="zero" colour={false} /></td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function PpeBody({ note, currency }: { note: PpeNote; currency: string }) {
  if (note.state === "empty") return null;
  return (
    <div className="grid gap-4 px-3 pb-3 lg:grid-cols-2">
      <MovementTable
        testId="ppe-cost"
        caption={`Cost — accounts ${note.costAccounts.join(", ")}`}
        currency={currency}
        rows={[
          { label: "At the start of the year", minor: note.cost.openingMinor },
          { label: "Additions", minor: note.cost.additionsMinor },
          { label: "Disposals", minor: `-${note.cost.disposalsMinor}` },
        ]}
        closing={{ label: "At the end of the year", minor: note.cost.closingMinor }}
        perLedger={note.cost.perBalanceSheetMinor}
        agrees={note.cost.agrees}
      />
      <MovementTable
        testId="ppe-depreciation"
        caption={`Accumulated depreciation — account ${note.accumulatedDepreciationAccount}`}
        currency={currency}
        rows={[
          { label: "At the start of the year", minor: note.accumulatedDepreciation.openingMinor },
          { label: "Charge for the year", minor: note.accumulatedDepreciation.chargeMinor },
          { label: "Released on disposal", minor: `-${note.accumulatedDepreciation.releasedOnDisposalMinor}` },
        ]}
        closing={{ label: "At the end of the year", minor: note.accumulatedDepreciation.closingMinor }}
        perLedger={note.accumulatedDepreciation.perBalanceSheetMinor}
        agrees={note.accumulatedDepreciation.agrees}
      />
      <div className="sw-scroll lg:col-span-2">
        <table className="sw-table" data-testid="ppe-categories">
          <caption className="sr-only">Net book value by class of asset, from the register</caption>
          <thead>
            <tr>
              <th scope="col">Class of asset</th>
              <th scope="col" className="sw-num">Assets</th>
              <th scope="col" className="sw-num">Cost</th>
              <th scope="col" className="sw-num">Depreciation</th>
              <th scope="col" className="sw-num">Net book value</th>
            </tr>
          </thead>
          <tbody>
            {note.byCategory.length === 0 && (
              <tr><td colSpan={5} className="sw-sub">Nothing on the register</td></tr>
            )}
            {note.byCategory.map((c) => (
              <tr key={c.category}>
                <th scope="row" style={{ fontWeight: 400 }}>{c.category}</th>
                <td className="sw-num">{c.count}</td>
                <td className="sw-num"><Figure minor={c.costMinor} currency={currency} colour={false} /></td>
                <td className="sw-num"><Figure minor={c.accumulatedMinor} currency={currency} colour={false} /></td>
                <td className="sw-num"><Figure minor={c.netBookValueMinor} currency={currency} colour={false} /></td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">Net book value at the end of the year</th>
              <td className="sw-num" />
              <td className="sw-num" />
              <td className="sw-num" />
              <td className="sw-num" data-testid="ppe-nbv">
                <Figure minor={note.netBookValue.closingMinor} currency={currency} zero="zero" colour={false} />
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="sw-sub lg:col-span-2">
        The register carries {note.register.assets} asset{note.register.assets === 1 ? "" : "s"}.{" "}
        <span className={`sw-chip ${note.register.costAgrees ? "sw-chip-ok" : "sw-chip-bad"}`}>
          cost {note.register.costAgrees ? "agrees" : "does not agree"}
        </span>{" "}
        <span className={`sw-chip ${note.register.accumulatedAgrees ? "sw-chip-ok" : "sw-chip-bad"}`}>
          depreciation {note.register.accumulatedAgrees ? "agrees" : "does not agree"}
        </span>
      </p>
    </div>
  );
}

function LeaseBody({ note, currency }: { note: LeaseNote; currency: string }) {
  if (note.state === "empty") return null;
  return (
    <div className="grid gap-4 px-3 pb-3 lg:grid-cols-2">
      <MovementTable
        testId="lease-rou"
        caption="Right-of-use assets"
        currency={currency}
        rows={[
          { label: "At the start of the year", minor: note.rightOfUseAssets.openingMinor },
          { label: "Additions on commencement", minor: note.rightOfUseAssets.additionsMinor },
          { label: "Depreciation for the year", minor: `-${note.rightOfUseAssets.depreciationMinor}` },
        ]}
        closing={{ label: "At the end of the year", minor: note.rightOfUseAssets.closingMinor }}
        perLedger={note.rightOfUseAssets.perBalanceSheetMinor}
        agrees={note.rightOfUseAssets.agrees}
      />
      <MovementTable
        testId="lease-liability"
        caption="Lease liabilities"
        currency={currency}
        rows={[
          { label: "At the start of the year", minor: note.liabilities.openingMinor },
          { label: "Recognised on commencement", minor: note.liabilities.additionsMinor },
          { label: "Interest unwound into the liability", minor: note.liabilities.interestMinor },
          { label: "Payments", minor: `-${note.liabilities.paymentsMinor}` },
        ]}
        closing={{ label: "At the end of the year", minor: note.liabilities.closingMinor }}
        perLedger={note.liabilities.perBalanceSheetMinor}
        agrees={note.liabilities.agrees}
      />
      <div className="sw-scroll">
        <table className="sw-table" data-testid="lease-charges">
          <caption className="sr-only">Amounts recognised in profit or loss and in cash</caption>
          <thead>
            <tr>
              <th scope="col">Recognised in the year</th>
              <th scope="col" className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Amount</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row" style={{ fontWeight: 400 }}>Depreciation of right-of-use assets (IFRS 16.53(a))</th>
              <td className="sw-num"><Figure minor={note.rightOfUseAssets.depreciationMinor} currency={currency} colour={false} /></td>
            </tr>
            <tr>
              <th scope="row" style={{ fontWeight: 400 }}>Interest on lease liabilities (IFRS 16.53(b))</th>
              <td className="sw-num"><Figure minor={note.interestExpenseMinor} currency={currency} colour={false} /></td>
            </tr>
            <tr>
              <th scope="row" style={{ fontWeight: 400 }}>Short-term and low-value leases (IFRS 16.53(c)-(d))</th>
              <td className="sw-num"><Figure minor={note.shortTermAndLowValueExpenseMinor} currency={currency} colour={false} /></td>
            </tr>
            <tr>
              <th scope="row" style={{ fontWeight: 600 }}>Total cash outflow for leases (IFRS 16.53(g))</th>
              <td className="sw-num" style={{ fontWeight: 600 }}>
                <Figure minor={note.totalCashOutflowMinor} currency={currency} zero="zero" colour={false} />
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div className="sw-scroll">
        <table className="sw-table" data-testid="lease-maturity">
          <caption className="sr-only">Maturity of the lease payments, undiscounted</caption>
          <thead>
            <tr>
              <th scope="col">Contractual payments still to be made</th>
              <th scope="col" className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Undiscounted</th>
            </tr>
          </thead>
          <tbody>
            {note.maturity.map((m) => (
              <tr key={m.key}>
                <th scope="row" style={{ fontWeight: 400 }}>{m.label}</th>
                <td className="sw-num"><Figure minor={m.amountMinor} currency={currency} colour={false} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {note.exemptions.length > 0 && (
        <div className="sw-scroll lg:col-span-2">
          <table className="sw-table" data-testid="lease-exemptions">
            <caption className="sr-only">Leases kept off the balance sheet under a recognition exemption</caption>
            <thead>
              <tr>
                <th scope="col">Off balance sheet</th>
                <th scope="col">Why</th>
                <th scope="col" className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Annual rent</th>
              </tr>
            </thead>
            <tbody>
              {note.exemptions.map((e) => (
                <tr key={e.code}>
                  <th scope="row" style={{ fontWeight: 400 }}>
                    <span className="sw-code me-2">{e.code}</span>{e.name}
                  </th>
                  <td className="sw-sub">{e.note}</td>
                  <td className="sw-num"><Figure minor={e.annualRentMinor} currency={currency} colour={false} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ul className="grid gap-1 lg:col-span-2">
        {note.notDerivable.map((t, i) => (
          <li key={i} className="sw-sub">{t}</li>
        ))}
      </ul>
    </div>
  );
}

function AgeingTable({ ageing, currency, testId }: { ageing: Ageing; currency: string; testId: string }) {
  return (
    <div className="sw-scroll">
      <table className="sw-table" data-testid={testId}>
        <caption className="sr-only">
          {ageing.name} at {ageing.asOf}, by age of the document
        </caption>
        <thead>
          <tr>
            <th scope="col">
              <span className="sw-code me-2">{ageing.account}</span>{ageing.name}
            </th>
            <th scope="col" className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Outstanding</th>
          </tr>
        </thead>
        <tbody>
          {ageing.bands.map((b) => (
            <tr key={b.key}>
              <th scope="row" style={{ fontWeight: 400 }}>{b.label}</th>
              <td className="sw-num"><Figure minor={b.amountMinor} currency={currency} colour={false} /></td>
            </tr>
          ))}
          <tr>
            <th scope="row" style={{ fontWeight: 600 }}>Total per the ageing</th>
            <td className="sw-num" style={{ fontWeight: 600 }}>
              <Figure minor={ageing.totalPerAgeingMinor} currency={currency} zero="zero" colour={false} />
            </td>
          </tr>
          <tr>
            <th scope="row" style={{ fontWeight: 400 }}>
              Per the control account
              <span className={`sw-chip ms-2 ${ageing.agrees ? "sw-chip-ok" : "sw-chip-bad"}`}>
                {ageing.agrees ? "agrees" : "does not agree"}
              </span>
            </th>
            <td className="sw-num">
              <Figure minor={ageing.totalPerLedgerMinor} currency={currency} zero="zero" colour={false} />
            </td>
          </tr>
        </tbody>
      </table>
      <p className="sw-sub pt-1">
        {ageing.openItems} open item{ageing.openItems === 1 ? "" : "s"}
        {ageing.oldestDays === null ? "" : `, the oldest ${ageing.oldestDays} days old`}.
      </p>
    </div>
  );
}

function TradeBody({ note, currency }: { note: ReceivablesPayablesNote; currency: string }) {
  if (note.state === "empty") return null;
  return (
    <div className="grid gap-4 px-3 pb-3 lg:grid-cols-2">
      <AgeingTable ageing={note.receivables} currency={currency} testId="ageing-receivables" />
      <AgeingTable ageing={note.payables} currency={currency} testId="ageing-payables" />
      <p className="sw-sub lg:col-span-2">
        Receivables are stated after an allowance for doubtful debts of{" "}
        <Figure minor={note.allowanceForDoubtfulDebtsMinor} currency={currency} colour={false} />, giving a net{" "}
        <Figure minor={note.netReceivablesMinor} currency={currency} zero="zero" colour={false} />.
      </p>
    </div>
  );
}

function RevenueBody({ note, currency }: { note: RevenueNote; currency: string }) {
  if (note.state === "empty") return null;
  return (
    <div className="grid gap-4 px-3 pb-3 lg:grid-cols-2">
      <div className="sw-scroll">
        <table className="sw-table" data-testid="revenue-by-treatment">
          <caption className="sr-only">Revenue by the tax treatment each sale was raised under</caption>
          <thead>
            <tr>
              <th scope="col">By tax treatment</th>
              <th scope="col" className="sw-num">Share</th>
              <th scope="col" className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Revenue</th>
            </tr>
          </thead>
          <tbody>
            {note.byTaxTreatment.map((t) => (
              <tr key={t.taxCode ?? "untagged"}>
                <th scope="row" style={{ fontWeight: 400 }}>{t.label}</th>
                <td className="sw-num">{t.shareBps === null ? "–" : `${(t.shareBps / 100).toFixed(2)}%`}</td>
                <td className="sw-num"><Figure minor={t.amountMinor} currency={currency} /></td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">Total revenue</th>
              <td className="sw-num" />
              <td className="sw-num" data-testid="revenue-total">
                <Figure minor={note.totalMinor} currency={currency} zero="zero" colour={false} />
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
      <div className="sw-scroll">
        <table className="sw-table" data-testid="revenue-by-account">
          <caption className="sr-only">Revenue by the account it was booked to</caption>
          <thead>
            <tr>
              <th scope="col">By account</th>
              <th scope="col" className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Revenue</th>
            </tr>
          </thead>
          <tbody>
            {note.byAccount.map((a) => (
              <tr key={a.code}>
                <th scope="row" style={{ fontWeight: 400 }}>
                  <span className="sw-code me-2">{a.code}</span>{a.name}
                </th>
                <td className="sw-num"><Figure minor={a.amountMinor} currency={currency} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {note.untaggedLines > 0 && (
        <p className="sw-sub lg:col-span-2" style={{ color: "var(--sw-neg)" }}>
          {note.untaggedLines} posting{note.untaggedLines === 1 ? "" : "s"} totalling{" "}
          <Figure minor={note.untaggedMinor} currency={currency} colour={false} /> carry no tax treatment, so they
          cannot be disaggregated and they will not appear on the VAT return either.
        </p>
      )}
    </div>
  );
}

function RelatedBody({ note, currency }: { note: RelatedPartyNote; currency: string }) {
  return (
    <div className="grid gap-3 px-3 pb-3">
      {note.state === "present" && (
        <div className="sw-scroll">
          <table className="sw-table" data-testid="related-party">
            <caption className="sr-only">
              Movements on the shareholder current account, the one balance related by construction
            </caption>
            <thead>
              <tr>
                <th scope="col">
                  <span className="sw-code me-2">{note.account.code}</span>{note.account.name}
                </th>
                <th scope="col" className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Amount</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row" style={{ fontWeight: 400 }}>At the start of the year</th>
                <td className="sw-num"><Figure minor={note.openingMinor} currency={currency} /></td>
              </tr>
              {note.movements.map((m) => (
                <tr key={m.key}>
                  <th scope="row" style={{ fontWeight: 400 }}>{m.label}</th>
                  <td className="sw-num"><Figure minor={m.amountMinor} currency={currency} /></td>
                </tr>
              ))}
              <tr>
                <th scope="row" style={{ fontWeight: 600 }}>At the end of the year</th>
                <td className="sw-num" style={{ fontWeight: 600 }}>
                  <Figure minor={note.closingMinor} currency={currency} zero="zero" />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
      <ul className="grid gap-1">
        {note.requiresInput.map((r, i) => (
          <li key={i} className="sw-sub">{r}</li>
        ))}
      </ul>
    </div>
  );
}

function TaxBody({ note, currency }: { note: TaxNote; currency: string }) {
  return (
    <div className="grid gap-4 px-3 pb-3 lg:grid-cols-2">
      <div className="sw-scroll">
        <table className="sw-table" data-testid="tax-reconciliation">
          <caption className="sr-only">
            Reconciliation of the tax charge to the accounting profit at the statutory rate
          </caption>
          <thead>
            <tr>
              <th scope="col">Reconciliation of the charge</th>
              <th scope="col" className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Tax</th>
            </tr>
          </thead>
          <tbody>
            {note.reconciliation.map((r) => (
              <tr key={r.key}>
                <th scope="row" style={{ fontWeight: 400, verticalAlign: "top", paddingBlock: "0.35rem" }}>
                  {r.label}
                  <div className="sw-sub">{r.basis}</div>
                </th>
                <td className="sw-num" style={{ verticalAlign: "top", paddingBlock: "0.35rem" }}>
                  <Figure minor={r.amountMinor} currency={currency} />
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">
                Corporate tax charge for the year
                <span className={`sw-chip ms-2 ${note.foots ? "sw-chip-ok" : "sw-chip-bad"}`}>
                  {note.foots ? "foots" : "does not foot"}
                </span>
              </th>
              <td className="sw-num" data-testid="tax-charge">
                <Figure minor={note.computedChargeMinor} currency={currency} zero="zero" colour={false} />
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
      <div className="sw-scroll">
        <table className="sw-table" data-testid="tax-position">
          <caption className="sr-only">The tax position as the books carry it</caption>
          <thead>
            <tr>
              <th scope="col">As the books carry it</th>
              <th scope="col" className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Amount</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row" style={{ fontWeight: 400 }}>Taxable income</th>
              <td className="sw-num"><Figure minor={note.taxableIncomeMinor} currency={currency} /></td>
            </tr>
            <tr>
              <th scope="row" style={{ fontWeight: 400 }}>Charged to profit in the year</th>
              <td className="sw-num"><Figure minor={note.chargePerLedgerMinor} currency={currency} /></td>
            </tr>
            <tr>
              <th scope="row" style={{ fontWeight: 400 }}>Corporate tax payable at the year end</th>
              <td className="sw-num"><Figure minor={note.payableClosingMinor} currency={currency} /></td>
            </tr>
            <tr>
              <th scope="row" style={{ fontWeight: 400 }}>Effective rate</th>
              <td className="sw-num">
                {note.effectiveRateBps === null ? "–" : `${(Number(note.effectiveRateBps) / 100).toFixed(2)}%`}
              </td>
            </tr>
            <tr>
              <th scope="row" style={{ fontWeight: 400 }}>Provision posted</th>
              <td className="sw-num">
                <span className={`sw-chip ${note.provisionPosted ? (note.provisionAgrees ? "sw-chip-ok" : "sw-chip-bad") : "sw-chip-warn"}`}>
                  {note.provisionPosted ? (note.provisionAgrees ? "posted and agrees" : "posted, differs") : "not posted"}
                </span>
              </td>
            </tr>
          </tbody>
        </table>
        <p className="sw-sub pt-1">{note.smallBusinessRelief.reason}</p>
      </div>
      {note.warnings.length > 0 && (
        <ul className="grid gap-2 lg:col-span-2" data-testid="tax-warnings">
          {note.warnings.map((w, i) => (
            <li key={i} className="sw-sub" style={{ color: "var(--sw-neg)" }}>{w}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * A note nobody can derive. The questions are shown rather than an empty
 * table, because the difference between "there were none" and "nobody has been
 * asked" is the whole point of showing this note at all.
 */
function RequiresInputBody({ note }: { note: RequiresInputNote }) {
  return (
    <ol className="grid gap-2 px-3 pb-3" data-testid={`requires-${note.key}`}>
      {note.requires.map((r) => (
        <li key={r.key} style={{ fontSize: "0.8125rem", lineHeight: 1.5, maxWidth: "80ch" }}>
          {r.question}
          <div className="sw-sub">{r.basis}</div>
        </li>
      ))}
    </ol>
  );
}
