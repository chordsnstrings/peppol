import Link from "next/link";
import { prisma } from "@/lib/server/prisma";
import { getSession } from "@/lib/server/session";
import { listRecords } from "@/lib/server/store";
import { LedgerError } from "@/lib/server/ledger/post";
import { financialKpis, asPercent, asTimes, type Kpi, type FinancialKpis } from "@/lib/server/ledger/kpi";
import { ftaAuditFile, type FtaAuditFile } from "@/lib/server/ledger/faf";
import { Figure, PageHead, Panel, ErrorNote, Empty } from "@/components/ledger/primitives";

/**
 * Insights: the ratios, and the file the FTA can ask for.
 *
 * Rendered on the server and filtered through the URL for the same reason the
 * audit trail is. A ratio is something people argue about — "our current ratio
 * fell below one in March" is only useful to the person you send it to if the
 * link reproduces exactly what you were looking at.
 *
 * Two things share this screen because they answer the same question from two
 * directions: is this set of books in a state you would be happy to show
 * somebody. The ratios say what the books mean; the audit file says whether
 * they can be handed over.
 *
 * The export produces a file. It does not submit anything to the FTA — sending
 * it is an act a human takes, on a file they have looked at, which is why the
 * reconciliation is on screen above the download button rather than behind it.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface EntityRecord {
  id: string;
  legalNameEn?: string;
}

type Search = Record<string, string | string[] | undefined>;
const one = (s: Search, k: string) => {
  const v = s[k];
  return ((Array.isArray(v) ? v[0] : v) ?? "").trim();
};

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** The figure a KPI card leads with, formatted exactly from its BigInt. */
function value(k: Kpi): React.ReactNode {
  if (k.unit === "MONEY") return <Figure minor={k.amountMinor} zero="zero" />;
  if (k.valueBps === null) {
    return <span className="sw-zero" title="This ratio has no denominator to divide by">–</span>;
  }
  const bps = BigInt(k.valueBps);
  if (k.unit === "PERCENT") return asPercent(bps);
  if (k.unit === "DAYS") return `${asTimes(bps)} days`;
  return `${asTimes(bps)}×`;
}

function KpiCard({ k, currency }: { k: Kpi; currency: string }) {
  return (
    <Panel className="p-3">
      <div className="flex items-start justify-between gap-2">
        <span className="sw-label">{k.label}</span>
        {!k.computable && (
          <span className="sw-chip sw-chip-warn" title="A zero denominator, not a value of zero">
            not calculable
          </span>
        )}
      </div>
      <div className="mt-1 text-[1.375rem] font-semibold tabular-nums" data-testid={`kpi-${k.key}-value`}>
        {value(k)}
      </div>
      <p className="sw-sub mt-1.5 max-w-[46ch]" data-testid={`kpi-${k.key}-interpretation`}>
        {k.interpretation}
      </p>
      <table className="sw-table mt-2.5">
        <caption className="sr-only">The figures behind {k.label}</caption>
        <tbody>
          {k.inputs.map((i) => (
            <tr key={i.label}>
              <th scope="row" style={{ fontWeight: 400 }}>{i.label}</th>
              <td className="sw-num"><Figure minor={i.amountMinor} currency={currency} zero="zero" colour={false} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="sw-sub mt-2" style={{ fontSize: "0.75rem" }}>{k.basis}</p>
    </Panel>
  );
}

export default async function InsightsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const session = await getSession();
  if (!session) return <Empty>Sign in to read the financial ratios.</Empty>;
  const { orgId, userId } = session;

  const sp = await searchParams;

  // The entity: whatever the URL says, else whichever one the user last chose
  // elsewhere in the app, else the first this organisation has.
  const entities = await listRecords<EntityRecord>(orgId, "entities");
  const chosen = await prisma.userMeta
    .findUnique({ where: { userId_key: { userId, key: "currentEntityId" } } })
    .then((r) => (r ? (JSON.parse(r.data) as string | undefined) : undefined))
    .catch(() => undefined);
  const entityId = one(sp, "entityId") || (chosen && entities.some((e) => e.id === chosen) ? chosen : entities[0]?.id) || "";

  const today = new Date();
  const from = one(sp, "from") || `${today.getUTCFullYear()}-01-01`;
  const to = one(sp, "to") || isoDay(today);

  // The two halves fail independently. An entity with no TRN still has ratios
  // worth reading, and a period with no trading still has a file to produce —
  // so one refusal must not blank the other.
  let kpis: FinancialKpis | null = null;
  let kpiError: string | null = null;
  let faf: FtaAuditFile | null = null;
  let fafError: string | null = null;

  if (entityId) {
    const [k, f] = await Promise.all([
      financialKpis({ orgId, entityId, from, to }).catch((e: unknown) => e),
      ftaAuditFile({ orgId, entityId, from, to }).catch((e: unknown) => e),
    ]);
    if (k instanceof Error) kpiError = k instanceof LedgerError ? k.message : "The ratios could not be computed.";
    else kpis = k as FinancialKpis;
    if (f instanceof Error) fafError = f instanceof LedgerError ? f.message : "The audit file could not be produced.";
    else faf = f as FtaAuditFile;
  }

  const query = new URLSearchParams({ entityId, from, to, format: "csv" }).toString();
  const currency = kpis?.currency ?? faf?.currency ?? "AED";

  return (
    <>
      <PageHead
        title="Insights"
        sub="The ratios these books produce, each with the sentence that says what it means, and the FTA Audit File the same books can be exported as. Both are read from the statements rather than recomputed, so nothing here can disagree with the accounts."
      />

      <Panel className="mb-4 p-3">
        <form method="get" className="flex flex-wrap items-end gap-3">
          <label className="grid gap-1">
            <span className="sw-label">Entity</span>
            <select name="entityId" defaultValue={entityId} className="sw-select" style={{ width: "14rem" }}>
              {entities.length === 0 && <option value="">No entities</option>}
              {entities.map((e) => (
                <option key={e.id} value={e.id}>{e.legalNameEn ?? e.id}</option>
              ))}
            </select>
          </label>
          <label className="grid gap-1">
            <span className="sw-label">From</span>
            <input type="date" name="from" defaultValue={from} className="sw-input" style={{ width: "9.5rem" }} />
          </label>
          <label className="grid gap-1">
            <span className="sw-label">To</span>
            <input type="date" name="to" defaultValue={to} className="sw-input" style={{ width: "9.5rem" }} />
          </label>
          <button type="submit" className="sw-btn">Show</button>
        </form>
      </Panel>

      {!entityId && <Empty>This organisation has no entities yet, so there is nothing to measure.</Empty>}

      {/* ------------------------------------------------------- the ratios */}

      {kpiError && <ErrorNote>{kpiError}</ErrorNote>}

      {kpis && (
        <section aria-labelledby="ratios-heading" className="mb-6">
          <h2 id="ratios-heading" className="sw-label mb-2">
            Ratios for {kpis.from} to {kpis.to} — {kpis.days} days
          </h2>

          {kpis.warnings.map((w, i) => (
            <div key={i} className="sw-error mb-3" role="alert" data-testid="kpi-warning">{w}</div>
          ))}

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {kpis.kpis.map((k) => <KpiCard key={k.key} k={k} currency={kpis.currency} />)}
          </div>

          <p className="sw-sub mt-3 max-w-[74ch]">
            Every ratio is computed in whole basis points from the{" "}
            <Link href="/accounting/statements" className="sw-link">profit and loss and the balance sheet</Link>,
            never in a floating-point number: a margin that disagrees with itself at the fourth decimal place is a
            margin nobody can check. A ratio whose denominator is zero is shown as “not calculable” rather than as
            zero — “no debt” and “cannot be calculated” are different facts about a business.
          </p>
        </section>
      )}

      {/* --------------------------------------------------- the audit file */}

      <section aria-labelledby="faf-heading">
        <h2 id="faf-heading" className="sw-label mb-2">FTA Audit File</h2>

        {fafError && <ErrorNote>{fafError}</ErrorNote>}

        {faf && (
          <>
            <Panel className="p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="max-w-[62ch]">
                  <p className="sw-sub">
                    The extract the FTA can ask a taxable person to produce: the company record, every purchase,
                    every supply, and the general ledger behind them, each section closed by a footer stating its
                    record count and totals. It is built from the same journal lines as the trial balance and the
                    VAT&nbsp;201.
                  </p>
                  <p className="sw-sub mt-2">
                    <strong>{faf.company.legalName}</strong> · TRN <span className="sw-code">{faf.company.trn}</span>
                    {faf.company.tradeLicenceNo && <> · licence <span className="sw-code">{faf.company.tradeLicenceNo}</span></>}
                    {" "}· {faf.periodFrom} to {faf.periodTo} · {faf.rowCount} rows · layout {faf.layoutVersion}
                  </p>
                </div>
                <div className="grid justify-items-end gap-2">
                  <span
                    className={`sw-chip ${faf.reconciles ? "sw-chip-ok" : "sw-chip-bad"}`}
                    data-testid="faf-reconciles"
                  >
                    {faf.reconciles ? "agrees with the ledger" : "does not agree with the ledger"}
                  </span>
                  <a
                    className="sw-btn sw-btn-primary"
                    href={`/api/ledger/faf?${query}`}
                    data-testid="faf-download"
                    download
                  >
                    Download the CSV
                  </a>
                </div>
              </div>

              {!faf.reconciles && (
                <div className="sw-error mt-3" role="alert">
                  This file does not carry everything the ledger does — the differences are listed below. It can
                  still be downloaded, because sometimes the difference is the finding, but read the reasons first.
                </div>
              )}
              <p className="sw-sub mt-3">
                This produces a file. It does not submit anything: handing it to the FTA is a separate act, taken on
                a file you have looked at.
              </p>
            </Panel>

            {faf.warnings.map((w, i) => (
              <div key={i} className="sw-error mt-3" role="alert" data-testid="faf-warning">{w}</div>
            ))}

            <div className="mt-4 grid gap-4 lg:grid-cols-2">
              <Panel className="overflow-hidden">
                <div className="border-b px-3 py-2" style={{ borderColor: "var(--sw-line)", background: "var(--sw-surface-2)" }}>
                  <span className="sw-label">Sections, and what their footers claim</span>
                </div>
                <div className="sw-scroll">
                  <table className="sw-table" data-testid="faf-sections">
                    <caption className="sr-only">Each section of the audit file, its record count and the totals its footer states</caption>
                    <thead>
                      <tr>
                        <th>Section</th>
                        <th className="sw-num" style={{ width: "5rem" }}>Records</th>
                        <th>Footer</th>
                        <th style={{ width: "7rem" }}>Footer check</th>
                      </tr>
                    </thead>
                    <tbody>
                      {faf.sections.map((s) => (
                        <tr key={s.key} data-testid={`faf-section-${s.key}`}>
                          <th scope="row" style={{ fontWeight: 400 }}>
                            {s.label} <span className="sw-code">{s.recordType}</span>
                          </th>
                          <td className="sw-num">{s.recordCount}</td>
                          <td className="sw-sub">
                            {s.footer.length === 0
                              ? "This section carries no footer of its own."
                              : s.footer.map((f) => `${f.label} ${f.value}`).join(" · ")}
                          </td>
                          <td>
                            <span className={`sw-chip ${s.footerAgreesWithRows ? "sw-chip-ok" : "sw-chip-bad"}`}>
                              {s.footerAgreesWithRows ? "matches its rows" : "does not match"}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Panel>

              <Panel className="overflow-hidden">
                <div className="border-b px-3 py-2" style={{ borderColor: "var(--sw-line)", background: "var(--sw-surface-2)" }}>
                  <span className="sw-label">The file against the ledger</span>
                </div>
                <div className="sw-scroll">
                  <table className="sw-table" data-testid="faf-checks">
                    <caption className="sr-only">Each total in the file checked against the same figure summed from the ledger</caption>
                    <thead>
                      <tr>
                        <th>Check</th>
                        <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>In the file</th>
                        <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>In the ledger</th>
                        <th style={{ width: "5.5rem" }} />
                      </tr>
                    </thead>
                    <tbody>
                      {faf.checks.map((c) => (
                        <tr key={c.key} data-testid={`faf-check-${c.key}`}>
                          <th scope="row" style={{ fontWeight: 400 }}>
                            {c.label}
                            {!c.agrees && <span className="sw-sub" style={{ display: "block" }}>{c.note}</span>}
                          </th>
                          <td className="sw-num tabular-nums">{c.perFile}</td>
                          <td className="sw-num tabular-nums">{c.perLedger}</td>
                          <td>
                            <span className={`sw-chip ${c.agrees ? "sw-chip-ok" : "sw-chip-bad"}`}>
                              {c.agrees ? "agrees" : `out by ${c.difference}`}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <th scope="row">Total difference across the money checks</th>
                        <td className="sw-num" colSpan={2}>
                          <Figure minor={faf.differenceMinor} currency={faf.currency} zero="zero" />
                        </td>
                        <td />
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </Panel>
            </div>

            <Panel className="mt-4 overflow-hidden">
              <div className="border-b px-3 py-2" style={{ borderColor: "var(--sw-line)", background: "var(--sw-surface-2)" }}>
                <span className="sw-label">The first {faf.preview.length} rows of the file</span>
              </div>
              <div className="sw-scroll p-3">
                <pre
                  className="sw-code"
                  style={{ margin: 0, fontSize: "0.75rem", lineHeight: 1.6, whiteSpace: "pre" }}
                  data-testid="faf-preview"
                >
                  {faf.preview.join("\n")}
                </pre>
              </div>
            </Panel>

            <Panel className="mt-4 overflow-hidden">
              <div className="border-b px-3 py-2" style={{ borderColor: "var(--sw-line)", background: "var(--sw-surface-2)" }}>
                <span className="sw-label">Columns, so they can be checked against the specification</span>
              </div>
              <div className="sw-scroll">
                <table className="sw-table" data-testid="faf-columns">
                  <caption className="sr-only">The field names written in each section of the audit file</caption>
                  <tbody>
                    {faf.sections.map((s) => (
                      <tr key={s.key}>
                        <th scope="row" style={{ fontWeight: 400, width: "14rem" }}>{s.label}</th>
                        <td className="sw-sub">{s.columns.join(" · ")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="sw-sub px-3 pb-3 pt-2 max-w-[80ch]">
                The record-type letters and this column order follow the audit-file layout the UAE file is modelled
                on rather than a quotation from the FTA’s own document, and no header row is written. Check the
                names above against the current FTA specification before this file is sent to anybody — the code
                says the same thing, at the top of <span className="sw-code">faf.ts</span>.
              </p>
            </Panel>
          </>
        )}
      </section>
    </>
  );
}
