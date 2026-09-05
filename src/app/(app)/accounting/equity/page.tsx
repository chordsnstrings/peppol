"use client";

import * as React from "react";
import Link from "next/link";
import { useEntityId, useLedgerQuery } from "@/components/ledger/use-ledger";
import { Figure, PageHead, Panel, ErrorNote, Loading } from "@/components/ledger/primitives";

/*
 * The wire shapes are the server's own, imported rather than copied.
 *
 * They used to be redeclared here, and the copy was the defect. `notes` is a
 * discriminated union that grows whenever a disclosure is added; this file held
 * its own version of that union, the compiler had nothing to hold the two
 * against, and a note added on the server therefore reached a `switch` that had
 * never heard of its key. The first time that happened the fallback called
 * `.map` on a field the new note did not carry and the whole pack went down;
 * the fix at the time stopped the crash and left the note rendering as a bare
 * heading with nothing under it, which is quieter and no better — a disclosure
 * that is silently missing from a set of financial statements is the failure,
 * not the stack trace.
 *
 * `import type` is erased at build, so nothing server-side is bundled: what
 * crosses is the shape. Amounts arrive as decimal strings of minor units and
 * are formatted by <Figure>; nothing on this page turns money into a
 * JavaScript number.
 */
import type {
  EquityAndNotes as Payload,
  EquityColumn as Column,
  EquityRow as Row,
  StatementOfChangesInEquity as Statement,
  Note,
  NoteState,
  PolicyNote,
  PpeNote,
  IntangiblesNote,
  LeaseNote,
  ReceivablesPayablesNote,
  CreditRiskNote,
  RevenueNote,
  RelatedPartyNote,
  ProvisionsNote,
  DeferredTaxNote,
  StatutoryReserveNote,
  TaxNote,
  RequiresInputNote,
  AgeingDisclosure as Ageing,
  MaturityDisclosure,
} from "@/lib/server/ledger/equity";

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
    case "intangible_assets": return <IntangiblesBody note={note} currency={currency} />;
    case "leases": return <LeaseBody note={note} currency={currency} />;
    case "trade_receivables_and_payables": return <TradeBody note={note} currency={currency} />;
    case "credit_risk": return <CreditRiskBody note={note} currency={currency} />;
    case "revenue": return <RevenueBody note={note} currency={currency} />;
    case "related_parties": return <RelatedBody note={note} currency={currency} />;
    case "provisions": return <ProvisionsBody note={note} currency={currency} />;
    case "deferred_tax": return <DeferredTaxBody note={note} currency={currency} />;
    case "corporate_tax": return <TaxBody note={note} currency={currency} />;
    case "statutory_reserve": return <StatutoryReserveBody note={note} currency={currency} />;
    case "events_after_the_reporting_period":
    case "commitments_and_contingencies":
      return <RequiresInputBody note={note} />;
    default: {
      /*
       * Two guards, and they catch different failures.
       *
       * `unhandled` is `never` for as long as the cases above cover the whole
       * of the server's union, so adding a disclosure without teaching this
       * page fails the build instead of shipping a note that renders as a bare
       * heading. That is the compile-time half.
       *
       * The generic body underneath is the runtime half and it is not dead
       * code. A type is a promise about one build; this page is a browser
       * bundle being served JSON by an API that can be a deploy ahead of it,
       * and a deployment window is exactly when a new note appears. So an
       * unknown note renders its own contents — every field it carries, in the
       * shapes it carries them — rather than nothing at all.
       */
      const unhandled: never = note;
      return <GenericNoteBody note={unhandled} currency={currency} />;
    }
  }
}

/* ------------------------------------------- the body for a note not taught */

/** The fields every note has, which the panel header has already shown. */
const NOTE_HEADER_FIELDS = new Set(["number", "key", "title", "basis", "state", "statement"]);

/** `netReceivablesMinor` → "Net receivables". Good enough to read, always. */
function humanise(key: string): string {
  const words = key
    .replace(/Minor$/, "")
    .replace(/Bps$/, " (basis points)")
    .replace(/([A-Z])/g, " $1")
    .replace(/_/g, " ")
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const isMoney = (key: string) => key.endsWith("Minor");

/** A scalar, rendered as what it is: money, a flag, or text. */
function GenericValue({ name, value, currency }: { name: string; value: unknown; currency: string }) {
  if (value === null || value === undefined) return <span className="sw-sub">not stated</span>;
  if (typeof value === "boolean") return <span className="sw-chip">{value ? "yes" : "no"}</span>;
  if (isMoney(name) && (typeof value === "string" || typeof value === "number")) {
    return <Figure minor={String(value)} currency={currency} zero="zero" />;
  }
  return <>{String(value)}</>;
}

/**
 * Any note, rendered from its own shape.
 *
 * Deliberately plain. It is not trying to be the hand-built table a disclosure
 * eventually deserves — it is trying to make sure every figure the server sent
 * reaches the page, in a form somebody can read, on the day the note appears
 * rather than on the day this file is next edited.
 */
function GenericNoteBody({ note, currency }: { note: Note; currency: string }) {
  const fields = Object.entries(note as unknown as Record<string, unknown>)
    .filter(([k]) => !NOTE_HEADER_FIELDS.has(k));
  if (fields.length === 0) return null;

  const scalars = fields.filter(([, v]) => v === null || typeof v !== "object");
  const objects = fields.filter(([, v]) => v !== null && typeof v === "object" && !Array.isArray(v));
  const lists = fields.filter(([, v]) => Array.isArray(v)) as [string, unknown[]][];

  return (
    <div className="grid gap-4 px-3 pb-3" data-testid={`generic-${note.key}`}>
      {(scalars.length > 0 || objects.length > 0) && (
        <div className="sw-scroll">
          <table className="sw-table">
            <caption className="sr-only">Everything this note carries, field by field</caption>
            <tbody>
              {scalars.map(([k, v]) => (
                <tr key={k}>
                  <th scope="row" style={{ fontWeight: 400 }}>{humanise(k)}</th>
                  <td className={isMoney(k) ? "sw-num" : ""}>
                    <GenericValue name={k} value={v} currency={currency} />
                  </td>
                </tr>
              ))}
              {objects.flatMap(([k, v]) =>
                Object.entries(v as Record<string, unknown>).map(([ik, iv]) => (
                  <tr key={`${k}.${ik}`}>
                    <th scope="row" style={{ fontWeight: 400 }}>
                      {humanise(k)} — {humanise(ik)}
                    </th>
                    <td className={isMoney(ik) ? "sw-num" : ""}>
                      <GenericValue name={ik} value={iv} currency={currency} />
                    </td>
                  </tr>
                )),
              )}
            </tbody>
          </table>
        </div>
      )}
      {lists.map(([k, rows]) => (
        <GenericList key={k} name={k} rows={rows} currency={currency} />
      ))}
    </div>
  );
}

function GenericList({ name, rows, currency }: { name: string; rows: unknown[]; currency: string }) {
  if (rows.length === 0) return null;
  const asObjects = rows.every((r) => r !== null && typeof r === "object" && !Array.isArray(r));
  if (!asObjects) {
    return (
      <div>
        <div className="sw-label">{humanise(name)}</div>
        <ul className="grid gap-1">
          {rows.map((r, i) => (
            <li key={i} className="sw-sub" style={{ maxWidth: "80ch" }}>{String(r)}</li>
          ))}
        </ul>
      </div>
    );
  }
  // The union of keys, in the order the first row that carries each one puts
  // it, so a row with an extra field still shows it rather than losing it.
  const columns: string[] = [];
  for (const r of rows as Record<string, unknown>[]) {
    for (const k of Object.keys(r)) if (!columns.includes(k)) columns.push(k);
  }
  return (
    <div>
      <div className="sw-label">{humanise(name)}</div>
      <div className="sw-scroll mt-1">
        <table className="sw-table">
          <caption className="sr-only">{humanise(name)}</caption>
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c} scope="col" className={isMoney(c) ? "sw-num" : ""}>{humanise(c)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(rows as Record<string, unknown>[]).map((r, i) => (
              <tr key={i}>
                {columns.map((c) => (
                  <td key={c} className={isMoney(c) ? "sw-num" : ""}>
                    <GenericValue name={c} value={r[c]} currency={currency} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
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

/**
 * IAS 38.118: the movement on intangible assets, and the classes behind it.
 *
 * Two tables and no revaluation column, unlike the note above. IAS 38.75
 * permits the revaluation model only where an active market exists for the
 * asset, and none exists for software or a licence — so nothing here revalues
 * an intangible, and a column that is always nil would only invite somebody to
 * look for the entry that filled it.
 */
function IntangiblesBody({ note, currency }: { note: IntangiblesNote; currency: string }) {
  if (note.state === "empty") return null;
  const months = (a: number, b: number) => (a === b ? `${a} months` : `${a}–${b} months`);
  return (
    <div className="grid gap-4 px-3 pb-3 lg:grid-cols-2">
      <MovementTable
        testId="intangible-cost"
        caption={`Cost — account ${note.costAccount}`}
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
        testId="intangible-amortisation"
        caption={`Accumulated amortisation — account ${note.accumulatedAmortisationAccount}`}
        currency={currency}
        rows={[
          { label: "At the start of the year", minor: note.accumulatedAmortisation.openingMinor },
          { label: "Charge for the year", minor: note.accumulatedAmortisation.chargeMinor },
          { label: "Released on disposal", minor: `-${note.accumulatedAmortisation.releasedOnDisposalMinor}` },
        ]}
        closing={{ label: "At the end of the year", minor: note.accumulatedAmortisation.closingMinor }}
        perLedger={note.accumulatedAmortisation.perBalanceSheetMinor}
        agrees={note.accumulatedAmortisation.agrees}
      />

      {note.byCategory.length > 0 && (
        <div className="sw-scroll lg:col-span-2">
          <table className="sw-table" data-testid="intangible-classes">
            <caption className="sr-only">Intangible assets by class, with the amortisation period</caption>
            <thead>
              <tr>
                <th scope="col">Class</th>
                <th scope="col" className="sw-num" style={{ width: "5rem" }}>Assets</th>
                <th scope="col">Amortised over</th>
                <th scope="col" className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Cost</th>
                <th scope="col" className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Amortisation</th>
                <th scope="col" className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Carrying amount</th>
              </tr>
            </thead>
            <tbody>
              {note.byCategory.map((c) => (
                <tr key={c.category}>
                  <th scope="row">{c.category.toLowerCase()}</th>
                  <td className="sw-num">{c.count}</td>
                  <td className="sw-sub">{months(c.shortestLifeMonths, c.longestLifeMonths)}</td>
                  <td className="sw-num"><Figure minor={c.costMinor} currency={currency} zero="zero" colour={false} /></td>
                  <td className="sw-num"><Figure minor={c.accumulatedMinor} currency={currency} zero="zero" colour={false} /></td>
                  <td className="sw-num"><Figure minor={c.netBookValueMinor} currency={currency} zero="zero" colour={false} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {note.notDerivable.length > 0 && (
        <div className="lg:col-span-2">
          <div className="sw-label">What this note cannot say</div>
          <ul className="grid gap-1">
            {note.notDerivable.map((line) => (
              <li key={line} className="sw-sub" style={{ maxWidth: "80ch" }}>{line}</li>
            ))}
          </ul>
        </div>
      )}
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
        {ageing.oldestDays === null ? "" : `, the oldest ${ageing.oldestDays} days old`}. Of the total,{" "}
        <Figure minor={ageing.overdueMinor} currency={currency} zero="zero" colour={false} /> is past its own due
        date — which is a different question from how old it is, and only the terms on the document answer it.
      </p>
    </div>
  );
}

/**
 * IFRS 7.39(a): the same payables, laid out by when they have to be paid.
 *
 * A table of its own and not a relabelled ageing. The ageing beside it counts
 * forwards from the day each bill was raised, which is what credit control
 * needs; this counts forwards from the reporting date to the day the supplier
 * may demand the money, which is what a reader assessing liquidity needs. On
 * ninety-day terms the two say opposite things about the same bill.
 */
function MaturityTable({ maturity, currency }: { maturity: MaturityDisclosure; currency: string }) {
  return (
    <div className="sw-scroll">
      <table className="sw-table" data-testid="maturity-payables">
        <caption className="sr-only">
          {maturity.name} at {maturity.asOf}, by remaining contractual maturity
        </caption>
        <thead>
          <tr>
            <th scope="col">
              <span className="sw-code me-2">{maturity.account}</span>When it falls due
            </th>
            <th scope="col" className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Undiscounted</th>
          </tr>
        </thead>
        <tbody>
          {maturity.bands.map((b) => (
            <tr key={b.key}>
              <th scope="row" style={{ fontWeight: 400 }}>{b.label}</th>
              <td className="sw-num"><Figure minor={b.amountMinor} currency={currency} colour={false} /></td>
            </tr>
          ))}
          <tr>
            <th scope="row" style={{ fontWeight: 600 }}>Total contractual payments</th>
            <td className="sw-num" style={{ fontWeight: 600 }}>
              <Figure minor={maturity.totalMinor} currency={currency} zero="zero" colour={false} />
            </td>
          </tr>
        </tbody>
      </table>
      <p className="sw-sub pt-1">
        {maturity.undatedItems === 0
          ? "Every payable carries terms, so every one of them is on the ladder above."
          : `${maturity.undatedItems} payable${maturity.undatedItems === 1 ? "" : "s"} carr` +
            `${maturity.undatedItems === 1 ? "ies" : "y"} no payment terms. They are shown on their own row rather ` +
            `than assumed to be payable on demand — no terms recorded is a fact about the keying, not about the ` +
            `supplier's contract.`}
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
      <MaturityTable maturity={note.payablesMaturity} currency={currency} />
      <p className="sw-sub">
        Receivables are stated after an allowance for doubtful debts of{" "}
        <Figure minor={note.allowanceForDoubtfulDebtsMinor} currency={currency} colour={false} />, giving a net{" "}
        <Figure minor={note.netReceivablesMinor} currency={currency} zero="zero" colour={false} />. How that
        allowance was measured is in the credit risk note.
      </p>
    </div>
  );
}

/**
 * IFRS 7.35M and 7.35H: the provision matrix, and the loss allowance it moved.
 *
 * The matrix table shows the gross beside the exposure the rate was applied to,
 * because they differ wherever a band holds an unapplied credit note and a
 * reader who sees only one of the two cannot check the arithmetic. The
 * reconciliation keeps "charged" apart from "utilised" for the reason IFRS
 * 7.35I asks it to: a debt written off against the allowance is the allowance
 * doing its job, not a second charge to profit, and netting the two would make
 * a business that provides accurately look like one that keeps providing.
 */
function CreditRiskBody({ note, currency }: { note: CreditRiskNote; currency: string }) {
  if (note.state === "empty") return null;
  const r = note.reconciliation;
  return (
    <div className="grid gap-4 px-3 pb-3">
      <div className="sw-scroll">
        <table className="sw-table" data-testid="credit-risk-matrix">
          <caption className="sr-only">
            Trade receivables at {note.asOf} by age of the debt, with the loss rate applied to each band
          </caption>
          <thead>
            <tr>
              <th scope="col">Age of the debt</th>
              <th scope="col" className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Gross</th>
              <th scope="col" className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Exposure</th>
              <th scope="col" className="sw-num" style={{ width: "6rem" }}>Loss rate</th>
              <th scope="col" className="sw-num" style={{ width: "var(--sw-col-amount)" }}>
                Expected credit loss
              </th>
            </tr>
          </thead>
          <tbody>
            {note.matrix.map((m) => (
              <tr key={m.band}>
                <th scope="row" style={{ fontWeight: 400 }}>{m.label}</th>
                <td className="sw-num"><Figure minor={m.grossMinor} currency={currency} /></td>
                <td className="sw-num"><Figure minor={m.exposureMinor} currency={currency} colour={false} /></td>
                <td className="sw-num">{m.ratePercent}</td>
                <td className="sw-num"><Figure minor={m.lossMinor} currency={currency} colour={false} /></td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">Lifetime expected credit losses at {note.asOf}</th>
              <td className="sw-num">
                <Figure minor={note.grossReceivablesMinor} currency={currency} zero="zero" colour={false} />
              </td>
              <td className="sw-num" />
              <td className="sw-num" />
              <td className="sw-num" data-testid="credit-risk-target">
                <Figure minor={note.targetMinor} currency={currency} zero="zero" colour={false} />
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="sw-scroll">
        <table className="sw-table" data-testid="credit-risk-reconciliation">
          <caption className="sr-only">Movement in the loss allowance for the year</caption>
          <thead>
            <tr>
              <th scope="col">Loss allowance — account {note.allowanceAccount}</th>
              <th scope="col" className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Amount</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row" style={{ fontWeight: 400 }}>At the start of the year</th>
              <td className="sw-num"><Figure minor={r.openingMinor} currency={currency} /></td>
            </tr>
            <tr>
              <th scope="row" style={{ fontWeight: 400 }}>Charged to profit or loss</th>
              <td className="sw-num"><Figure minor={r.chargedMinor} currency={currency} /></td>
            </tr>
            <tr>
              <th scope="row" style={{ fontWeight: 400 }}>Released to profit or loss</th>
              <td className="sw-num"><Figure minor={`-${r.releasedMinor}`} currency={currency} /></td>
            </tr>
            <tr>
              <th scope="row" style={{ fontWeight: 400 }}>
                Used against debts written off
                <div className="sw-sub">
                  The expense was taken when the allowance was raised, so this is not a further charge.
                </div>
              </th>
              <td className="sw-num"><Figure minor={`-${r.utilisedMinor}`} currency={currency} /></td>
            </tr>
            {r.otherMinor !== "0" && (
              <tr>
                <th scope="row" style={{ fontWeight: 400 }}>
                  Other movements
                  <div className="sw-sub">
                    Postings to the allowance account from outside the measurement and the write-off, shown rather
                    than absorbed.
                  </div>
                </th>
                <td className="sw-num"><Figure minor={r.otherMinor} currency={currency} /></td>
              </tr>
            )}
            <tr>
              <th scope="row" style={{ fontWeight: 600 }}>At the end of the year</th>
              <td className="sw-num" style={{ fontWeight: 600 }}>
                <Figure minor={r.closingMinor} currency={currency} zero="zero" colour={false} />
              </td>
            </tr>
            <tr>
              <th scope="row" style={{ fontWeight: 400 }}>
                Per the balance sheet
                <span className={`sw-chip ms-2 ${r.agrees ? "sw-chip-ok" : "sw-chip-bad"}`}>
                  {r.agrees ? "agrees" : "does not agree"}
                </span>
              </th>
              <td className="sw-num">
                <Figure minor={r.perBalanceSheetMinor} currency={currency} zero="zero" colour={false} />
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <p className="sw-sub" style={{ maxWidth: "80ch" }} data-testid="credit-risk-difference">
        The matrix measures{" "}
        <Figure minor={note.targetMinor} currency={currency} zero="zero" colour={false} /> and the ledger carries{" "}
        <Figure minor={note.carriedMinor} currency={currency} zero="zero" colour={false} />, a difference of{" "}
        <Figure minor={note.differenceMinor} currency={currency} zero="zero" />. Receivables are stated net at{" "}
        <Figure minor={note.netReceivablesMinor} currency={currency} zero="zero" colour={false} />.{" "}
        {note.ratesAreDefault
          ? "The rates above are the product's default matrix rather than this entity's measured collection history, so read the difference as a reason to remeasure on the allowance screen rather than as a quantified under-provision."
          : ""}
      </p>

      {note.measurements.length > 0 && (
        <div>
          <div className="sw-label">Measured during the year</div>
          <div className="sw-scroll mt-1">
            <table className="sw-table" data-testid="credit-risk-measurements">
              <caption className="sr-only">
                Allowance measurements posted in the year, with the matrix recorded on each entry
              </caption>
              <thead>
                <tr>
                  <th scope="col" style={{ width: "7rem" }}>Measured at</th>
                  <th scope="col" style={{ width: "8rem" }}>Entry</th>
                  <th scope="col" className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Movement</th>
                  <th scope="col">The matrix it was measured on</th>
                </tr>
              </thead>
              <tbody>
                {note.measurements.map((m) => (
                  <tr key={m.reference}>
                    <th scope="row" style={{ fontWeight: 400 }}>{m.date}</th>
                    <td>{m.reference}</td>
                    <td className="sw-num"><Figure minor={m.movementMinor} currency={currency} /></td>
                    <td className="sw-sub" style={{ maxWidth: "60ch" }}>{m.memo}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div>
        <div className="sw-label">What this note cannot say</div>
        <ul className="grid gap-1">
          {note.notDerivable.map((line) => (
            <li key={line} className="sw-sub" style={{ maxWidth: "80ch" }}>{line}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/**
 * Article 103 of Federal Decree-Law 32/2021, computed rather than remembered.
 *
 * The transfer is an appropriation within equity: it moves value from retained
 * earnings to the reserve and changes neither the total of equity nor the
 * result. What it does change is what may be distributed, which is why it is
 * worth being told about before the accounts are signed rather than after.
 */
function StatutoryReserveBody({ note, currency }: { note: StatutoryReserveNote; currency: string }) {
  if (note.state === "empty") return null;
  return (
    <div className="grid gap-4 px-3 pb-3 lg:grid-cols-2">
      <div className="sw-scroll">
        <table className="sw-table" data-testid="statutory-reserve">
          <caption className="sr-only">The statutory reserve, and what Article 103 asks of this year</caption>
          <thead>
            <tr>
              <th scope="col">
                <span className="sw-code me-2">{note.account}</span>Statutory reserve
              </th>
              <th scope="col" className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Amount</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row" style={{ fontWeight: 400 }}>At the start of the year</th>
              <td className="sw-num"><Figure minor={note.openingMinor} currency={currency} /></td>
            </tr>
            <tr>
              <th scope="row" style={{ fontWeight: 400 }}>Transferred in the year</th>
              <td className="sw-num" data-testid="reserve-transferred">
                <Figure minor={note.transferredMinor} currency={currency} />
              </td>
            </tr>
            <tr>
              <th scope="row" style={{ fontWeight: 600 }}>At the end of the year</th>
              <td className="sw-num" style={{ fontWeight: 600 }}>
                <Figure minor={note.closingMinor} currency={currency} zero="zero" colour={false} />
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="sw-scroll">
        <table className="sw-table" data-testid="statutory-reserve-requirement">
          <caption className="sr-only">The Article 103 computation for the year</caption>
          <thead>
            <tr>
              <th scope="col">What Article 103 asks of this year</th>
              <th scope="col" className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Amount</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row" style={{ fontWeight: 400 }}>
                Paid-up capital
                <span className="sw-code ms-2">{note.capitalAccount}</span>
              </th>
              <td className="sw-num">
                <Figure minor={note.paidUpCapitalMinor} currency={currency} zero="zero" colour={false} />
              </td>
            </tr>
            <tr>
              <th scope="row" style={{ fontWeight: 400 }}>Half of it, where the deduction may stop</th>
              <td className="sw-num"><Figure minor={note.capMinor} currency={currency} zero="zero" colour={false} /></td>
            </tr>
            <tr>
              <th scope="row" style={{ fontWeight: 400 }}>Result for the year</th>
              <td className="sw-num"><Figure minor={note.profitForThePeriodMinor} currency={currency} /></td>
            </tr>
            <tr>
              <th scope="row" style={{ fontWeight: 400 }}>Ten per cent of it</th>
              <td className="sw-num"><Figure minor={note.tenPercentMinor} currency={currency} zero="zero" colour={false} /></td>
            </tr>
            <tr>
              <th scope="row" style={{ fontWeight: 400 }}>Room below the cap before this year&rsquo;s transfer</th>
              <td className="sw-num"><Figure minor={note.headroomMinor} currency={currency} zero="zero" colour={false} /></td>
            </tr>
            <tr>
              <th scope="row" style={{ fontWeight: 600 }}>
                Required this year
                <span className={`sw-chip ms-2 ${note.satisfied ? "sw-chip-ok" : "sw-chip-warn"}`}>
                  {note.capReached ? "cap reached" : note.satisfied ? "appropriated" : "outstanding"}
                </span>
              </th>
              <td className="sw-num" style={{ fontWeight: 600 }} data-testid="reserve-required">
                <Figure minor={note.requiredMinor} currency={currency} zero="zero" colour={false} />
              </td>
            </tr>
            <tr>
              <th scope="row" style={{ fontWeight: 400 }}>Still to be appropriated</th>
              <td className="sw-num" data-testid="reserve-shortfall">
                <Figure minor={note.shortfallMinor} currency={currency} zero="zero" colour={false} />
              </td>
            </tr>
          </tbody>
        </table>
      </div>
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
  // Reached only by the two keys named in the switch above, so `requires` is
  // there by construction. It used to be the catch-all arm, which is how a note
  // added on the server reached it, failed to find `requires` and took the
  // whole pack down with an `undefined.map`. An unknown key now goes to the
  // generic body instead, and this one only handles what it was written for.
  const questions = note.requires;
  if (questions.length === 0) return null;
  return (
    <ol className="grid gap-2 px-3 pb-3" data-testid={`requires-${note.key}`}>
      {questions.map((r) => (
        <li key={r.key} style={{ fontSize: "0.8125rem", lineHeight: 1.5, maxWidth: "80ch" }}>
          {r.question}
          <div className="sw-sub">{r.basis}</div>
        </li>
      ))}
    </ol>
  );
}

/**
 * IAS 37.84: the movement on each class of provision, and the contingencies
 * beside it.
 *
 * The five movement columns are the standard's own (a)-(e) and they are
 * separate for a reason: an amount USED is a provision that did its job, and an
 * amount RELEASED is one that was never needed. Netting them into a single
 * "movement" column loses the difference between a business that estimates well
 * and one that provides for things that never happen, which is the question a
 * reader of this note is asking.
 */
function ProvisionsBody({ note, currency }: { note: ProvisionsNote; currency: string }) {
  if (note.state === "empty" && note.rows.length === 0 && note.contingentLiabilities.length === 0) return null;
  const cols: { key: keyof ProvisionsNote["totals"]; label: string }[] = [
    { key: "openingMinor", label: "At the start" },
    { key: "additionsMinor", label: "Provided" },
    { key: "usedMinor", label: "Used" },
    { key: "releasedMinor", label: "Released" },
    { key: "unwoundMinor", label: "Unwound" },
    { key: "closingMinor", label: "At the end" },
  ];
  return (
    <div className="grid gap-4 px-3 pb-3">
      {note.rows.length > 0 && (
        <div className="sw-scroll">
          <table className="sw-table" data-testid="provisions-movements">
            <caption className="sr-only">Movements on provisions in {note.periodLabel}</caption>
            <thead>
              <tr>
                <th scope="col">Class</th>
                {cols.map((c) => (
                  <th key={c.key} scope="col" className="sw-num" style={{ width: "var(--sw-col-amount)" }}>{c.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {note.rows.map((r) => (
                <tr key={r.category}>
                  <th scope="row">{r.label}</th>
                  {cols.map((c) => (
                    <td key={c.key} className="sw-num">
                      <Figure minor={r[c.key]} currency={currency} zero="dash" colour={false} />
                    </td>
                  ))}
                </tr>
              ))}
              <tr>
                <th scope="row" style={{ fontWeight: 600, borderTop: "1px solid var(--sw-line-strong)" }}>Total</th>
                {cols.map((c) => (
                  <td key={c.key} className="sw-num" style={{ fontWeight: 600, borderTop: "1px solid var(--sw-line-strong)" }}>
                    <Figure minor={note.totals[c.key]} currency={currency} zero="zero" colour={false} />
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {!note.agreesWithRegister && (
        // Two different facts, drawn differently. A difference explained by
        // movements after the reporting date is expected — the note is at the
        // reporting date and the register is at today — and it is a note. A
        // difference with no such explanation is a note that does not tie to
        // the accounts behind it, and publishing that is the thing to stop.
        <p
          className={note.movementsAfterAsOf > 0 ? "sw-note" : "sw-error"}
          style={{ maxWidth: "80ch" }}
          data-testid="provisions-disagrees"
        >
          The movements above close at a figure the provisions register does not carry
          (<Figure minor={note.carryingPerRegisterMinor} currency={currency} zero="zero" colour={false} />).
          {note.movementsAfterAsOf > 0
            ? ` ${note.movementsAfterAsOf} movement${note.movementsAfterAsOf === 1 ? " was" : "s were"} recorded after ` +
              `the reporting date, which is why the two differ.`
            : " Nothing was recorded after the reporting date, so the difference has to be explained before this note is published."}
        </p>
      )}

      <ContingencyTable
        testId="provisions-contingent-liabilities"
        caption="Contingent liabilities"
        blurb="IAS 37.86: disclosed, not provided for — the obligation turns on something outside the entity's control."
        rows={note.contingentLiabilities}
        currency={currency}
      />
      <ContingencyTable
        testId="provisions-contingent-assets"
        caption="Contingent assets"
        blurb="IAS 37.89: disclosed only where an inflow is probable, and never recognised — recognising one would book income that may never arrive."
        rows={note.contingentAssets}
        currency={currency}
      />

      {note.narrative.map((line) => (
        <p key={line} className="sw-sub" style={{ maxWidth: "80ch" }}>{line}</p>
      ))}
    </div>
  );
}

function ContingencyTable({
  testId, caption, blurb, rows, currency,
}: {
  testId: string; caption: string; blurb: string; currency: string;
  rows: { code: string; name: string; label: string; estimateMinor: string; expectedOn: string | null; note: string | null }[];
}) {
  if (rows.length === 0) return null;
  return (
    <div>
      <div className="sw-label">{caption}</div>
      <p className="sw-sub" style={{ maxWidth: "80ch" }}>{blurb}</p>
      <div className="sw-scroll mt-1">
        <table className="sw-table" data-testid={testId}>
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr>
              <th scope="col">What it is</th>
              <th scope="col">Class</th>
              <th scope="col">Expected</th>
              <th scope="col" className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Estimate</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.code}>
                <th scope="row">
                  {r.name}
                  {r.note && <div className="sw-sub">{r.note}</div>}
                </th>
                <td>{r.label}</td>
                <td>{r.expectedOn ?? <span className="sw-sub">no date</span>}</td>
                <td className="sw-num">
                  <Figure minor={r.estimateMinor} currency={currency} zero="zero" colour={false} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * IAS 12.81(g): deferred tax by TYPE of temporary difference, at each date
 * presented, with the movement between them.
 *
 * By type rather than by item, because a note listing every fixed asset is a
 * note nobody reads. Assets and liabilities are shown gross before the offset,
 * since IAS 12.74 only permits netting where there is a legal right to set off
 * — and the basis on which that was done is stated rather than assumed.
 */
function DeferredTaxBody({ note, currency }: { note: DeferredTaxNote; currency: string }) {
  if (note.state === "empty" && note.rows.length === 0) return null;
  const anyUnrecognised = note.totals.unrecognisedTaxMinor !== "0";
  return (
    <div className="grid gap-4 px-3 pb-3">
      {note.rows.length > 0 && (
        <div className="sw-scroll">
          <table className="sw-table" data-testid="deferred-tax-rows">
            <caption className="sr-only">
              Deferred tax by type of temporary difference at {note.asOf}
              {note.previousAsOf ? ` and ${note.previousAsOf}` : ""}
            </caption>
            <thead>
              <tr>
                <th scope="col">Temporary difference</th>
                <th scope="col" className="sw-num" style={{ width: "var(--sw-col-amount)" }}>
                  {note.previousAsOf ?? "Opening"}
                </th>
                <th scope="col" className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Asset</th>
                <th scope="col" className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Liability</th>
                <th scope="col" className="sw-num" style={{ width: "var(--sw-col-amount)" }}>{note.asOf}</th>
                <th scope="col" className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Movement</th>
                {anyUnrecognised && (
                  <th scope="col" className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Unrecognised</th>
                )}
              </tr>
            </thead>
            <tbody>
              {note.rows.map((r) => (
                <tr key={r.category}>
                  <th scope="row">{r.label}</th>
                  <td className="sw-num"><Figure minor={r.openingNetMinor} currency={currency} zero="dash" colour={false} /></td>
                  <td className="sw-num"><Figure minor={r.closingAssetMinor} currency={currency} zero="dash" colour={false} /></td>
                  <td className="sw-num"><Figure minor={r.closingLiabilityMinor} currency={currency} zero="dash" colour={false} /></td>
                  <td className="sw-num"><Figure minor={r.closingNetMinor} currency={currency} zero="dash" colour={false} /></td>
                  <td className="sw-num"><Figure minor={r.movementMinor} currency={currency} zero="dash" /></td>
                  {anyUnrecognised && (
                    <td className="sw-num"><Figure minor={r.unrecognisedTaxMinor} currency={currency} zero="dash" colour={false} /></td>
                  )}
                </tr>
              ))}
              <tr>
                <th scope="row" style={{ fontWeight: 600, borderTop: "1px solid var(--sw-line-strong)" }}>Total</th>
                {[
                  note.totals.openingNetMinor, note.totals.closingAssetMinor, note.totals.closingLiabilityMinor,
                  note.totals.closingNetMinor,
                ].map((m, i) => (
                  <td key={i} className="sw-num" style={{ fontWeight: 600, borderTop: "1px solid var(--sw-line-strong)" }}>
                    <Figure minor={m} currency={currency} zero="zero" colour={false} />
                  </td>
                ))}
                <td className="sw-num" style={{ fontWeight: 600, borderTop: "1px solid var(--sw-line-strong)" }}>
                  <Figure minor={note.totals.movementMinor} currency={currency} zero="zero" />
                </td>
                {anyUnrecognised && (
                  <td className="sw-num" style={{ fontWeight: 600, borderTop: "1px solid var(--sw-line-strong)" }}>
                    <Figure minor={note.totals.unrecognisedTaxMinor} currency={currency} zero="zero" colour={false} />
                  </td>
                )}
              </tr>
            </tbody>
          </table>
        </div>
      )}

      <p className="sw-sub" style={{ maxWidth: "80ch" }} data-testid="deferred-tax-offset">{note.offsetBasis}</p>
      {note.narrative.map((line) => (
        <p key={line} className="sw-sub" style={{ maxWidth: "80ch" }}>{line}</p>
      ))}
    </div>
  );
}
