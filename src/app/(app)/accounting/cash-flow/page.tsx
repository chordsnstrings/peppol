"use client";

import * as React from "react";
import Link from "next/link";
import { useEntityId, useLedgerQuery } from "@/components/ledger/use-ledger";
import { Figure, PageHead, Panel, ErrorNote, Loading } from "@/components/ledger/primitives";

interface CFLine {
  code: string | null;
  label: string;
  amountMinor: string;
  direction: "source" | "use" | "none";
  movementMinor: string | null;
  note: string | null;
}
interface CFSection {
  key: "operating" | "investing" | "financing";
  label: string;
  lines: CFLine[];
  totalMinor: string;
}
interface CF {
  from: string;
  to: string;
  currency: string;
  operating: CFSection;
  investing: CFSection;
  financing: CFSection;
  netCashMovementMinor: string;
  cashMovementPerLedgerMinor: string;
  reconciles: boolean;
  differenceMinor: string;
  openingCashMinor: string;
  closingCashMinor: string;
  cashAccounts: { code: string; name: string; openingMinor: string; closingMinor: string; movementMinor: string }[];
  warnings: string[];
}

function ytd() {
  const now = new Date();
  const y = now.getUTCFullYear();
  return { from: `${y}-01-01`, to: now.toISOString().slice(0, 10) };
}

export default function CashFlowPage() {
  const entityId = useEntityId();
  const [range, setRange] = React.useState(ytd);
  const { data, error, loading } = useLedgerQuery<{ cashFlow: CF }>(
    entityId ? `/api/ledger/cashflow?entityId=${entityId}&from=${range.from}&to=${range.to}` : null,
  );

  if (!entityId) return <Loading label="Choosing an entity…" />;
  const cf = data?.cashFlow;

  return (
    <>
      <PageHead
        title="Cash flow statement"
        sub="Where the cash went, by the indirect method (IAS 7). It starts from the profit for the period and works back to the movement on the bank — and it checks itself against that movement rather than balancing to it."
        actions={
          <>
            <label className="flex items-center gap-1.5">
              <span className="sw-label">From</span>
              <input type="date" className="sw-input" style={{ width: "9.5rem" }} value={range.from}
                onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))} />
            </label>
            <label className="flex items-center gap-1.5">
              <span className="sw-label">To</span>
              <input type="date" className="sw-input" style={{ width: "9.5rem" }} value={range.to}
                onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))} />
            </label>
          </>
        }
      />

      {error && <ErrorNote>{error}</ErrorNote>}
      {loading && <Loading />}

      {cf && (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
          <Panel className="overflow-hidden">
            <Head>Cash flow for {cf.from} to {cf.to}</Head>
            <div className="sw-scroll">
              <table className="sw-table">
                <caption className="sr-only">
                  Cash flow statement from {cf.from} to {cf.to}, by the indirect method
                </caption>
                <Rows section={cf.operating} currency={cf.currency} />
                <Rows section={cf.investing} currency={cf.currency} />
                <Rows section={cf.financing} currency={cf.currency} />
                <tfoot>
                  <tr>
                    <th scope="row" colSpan={2} style={{ textAlign: "end", borderTop: "1px solid var(--sw-line-strong)" }}>
                      Net movement in cash and cash equivalents
                    </th>
                    <td className="sw-num" data-testid="net-movement" style={{ borderTop: "1px solid var(--sw-line-strong)" }}>
                      <Figure minor={cf.netCashMovementMinor} currency={cf.currency} zero="zero" />
                    </td>
                  </tr>
                  <tr>
                    <th scope="row" colSpan={2} style={{ textAlign: "end", fontWeight: 400 }}>
                      Cash and cash equivalents at {cf.from}
                    </th>
                    <td className="sw-num" data-testid="opening-cash">
                      <Figure minor={cf.openingCashMinor} currency={cf.currency} zero="zero" colour={false} />
                    </td>
                  </tr>
                  <tr>
                    <th scope="row" colSpan={2} style={{ textAlign: "end" }}>
                      Cash and cash equivalents at {cf.to}
                    </th>
                    <td className="sw-num" data-testid="closing-cash">
                      <Figure minor={cf.closingCashMinor} currency={cf.currency} zero="zero" colour={false} />
                    </td>
                  </tr>
                  {!cf.reconciles && (
                    <tr>
                      <th scope="row" colSpan={2} style={{ textAlign: "end", color: "var(--sw-neg)" }}>
                        Unexplained difference
                      </th>
                      <td className="sw-num sw-num-neg" data-testid="difference">
                        <Figure minor={cf.differenceMinor} currency={cf.currency} zero="zero" />
                      </td>
                    </tr>
                  )}
                </tfoot>
              </table>
            </div>
            <p className="sw-sub px-3 py-2" style={{ borderTop: "1px solid var(--sw-line)" }} data-testid="cf-note">
              {cf.reconciles ? (
                <>
                  The three sections account for the whole{" "}
                  <Figure minor={cf.cashMovementPerLedgerMinor} currency={cf.currency} zero="zero" colour={false} /> the
                  cash accounts moved over this period. Nothing has been added to make them agree.
                </>
              ) : (
                <>
                  The sections total{" "}
                  <Figure minor={cf.netCashMovementMinor} currency={cf.currency} zero="zero" colour={false} /> but the
                  cash accounts moved by{" "}
                  <Figure minor={cf.cashMovementPerLedgerMinor} currency={cf.currency} zero="zero" colour={false} />.
                  The difference is left on the face of the statement rather than absorbed into a balancing figure —
                  see the notes beside it, then{" "}
                  <Link href="/accounting/journals" className="sw-link">check the journals</Link> for the account named.
                </>
              )}
            </p>
          </Panel>

          <div className="grid gap-4 content-start">
            <Panel className="overflow-hidden">
              <Head>Reconciliation</Head>
              <div className="sw-scroll">
                <table className="sw-table">
                  <caption className="sr-only">Reconciliation of the statement to the cash accounts</caption>
                  <tbody>
                    <tr>
                      <th scope="row">Per this statement</th>
                      <td className="sw-num"><Figure minor={cf.netCashMovementMinor} currency={cf.currency} zero="zero" /></td>
                    </tr>
                    <tr>
                      <th scope="row">Per the ledger</th>
                      <td className="sw-num"><Figure minor={cf.cashMovementPerLedgerMinor} currency={cf.currency} zero="zero" /></td>
                    </tr>
                    <tr>
                      <th scope="row" style={{ fontWeight: 600, borderTop: "1px solid var(--sw-line-strong)" }}>
                        Difference
                      </th>
                      <td className="sw-num" data-testid="reconcile-difference"
                        style={{ fontWeight: 600, borderTop: "1px solid var(--sw-line-strong)" }}>
                        <Figure minor={cf.differenceMinor} currency={cf.currency} zero="zero" />
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p className="sw-sub px-3 py-2" style={{ borderTop: "1px solid var(--sw-line)" }} data-testid="reconcile-state">
                {cf.reconciles ? "Reconciled." : "Does not reconcile."}
              </p>
            </Panel>

            <Panel className="overflow-hidden">
              <Head>Cash and cash equivalents</Head>
              <div className="sw-scroll">
                <table className="sw-table">
                  <caption className="sr-only">Movement on each cash account</caption>
                  <thead>
                    <tr>
                      <th scope="col">Account</th>
                      <th scope="col" className="sw-num">Opening</th>
                      <th scope="col" className="sw-num">Movement</th>
                      <th scope="col" className="sw-num">Closing</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cf.cashAccounts.length === 0 && (
                      <tr><td colSpan={4} className="sw-sub">No cash account carried a balance in this period</td></tr>
                    )}
                    {cf.cashAccounts.map((a) => (
                      <tr key={a.code}>
                        <th scope="row" style={{ fontWeight: 400 }}>
                          <span className="sw-code me-2">{a.code}</span>{a.name}
                        </th>
                        <td className="sw-num"><Figure minor={a.openingMinor} currency={cf.currency} colour={false} /></td>
                        <td className="sw-num"><Figure minor={a.movementMinor} currency={cf.currency} /></td>
                        <td className="sw-num"><Figure minor={a.closingMinor} currency={cf.currency} colour={false} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>

            {cf.warnings.length > 0 && (
              <Panel className="overflow-hidden">
                <Head>Before you rely on this</Head>
                <ul className="px-3 py-2 grid gap-2" data-testid="cf-warnings">
                  {cf.warnings.map((w, i) => (
                    <li key={i} className="sw-sub" style={{ color: "var(--sw-neg)" }}>{w}</li>
                  ))}
                </ul>
              </Panel>
            )}
          </div>
        </div>
      )}
    </>
  );
}

function Head({ children }: { children: React.ReactNode }) {
  return (
    <div className="border-b px-3 py-2" style={{ borderColor: "var(--sw-line)", background: "var(--sw-surface-2)" }}>
      <span className="sw-label">{children}</span>
    </div>
  );
}

/**
 * A section of the statement. The amount column is the cash effect, so an
 * outflow is negative and the Figure renders it in parentheses; the word beside
 * the label says the same thing again, because a reader scanning a column of
 * figures should not have to work out which way a working capital movement runs.
 */
function Rows({ section, currency }: { section: CFSection; currency: string }) {
  return (
    <tbody data-testid={`section-${section.key}`}>
      <tr>
        <td colSpan={3} style={{ background: "var(--sw-surface-2)", height: "1.75rem" }}>
          <span className="sw-label">{section.label}</span>
        </td>
      </tr>
      {section.lines.length === 0 && (
        <tr><td colSpan={3} className="sw-sub" style={{ paddingInlineStart: "1.5rem" }}>Nothing in this period</td></tr>
      )}
      {section.lines.map((l, i) => (
        <tr key={`${l.code ?? "derived"}-${i}`}>
          <td className="sw-code" style={{ width: "5rem" }}>{l.code ?? ""}</td>
          <td>
            {l.label}
            {l.direction !== "none" && (
              <span className="sw-sub ms-2">{l.direction === "source" ? "source of cash" : "use of cash"}</span>
            )}
            {l.note && <div className="sw-sub" style={{ maxWidth: "58ch" }}>{l.note}</div>}
          </td>
          <td className="sw-num" style={{ width: "var(--sw-col-amount)", verticalAlign: "top" }}>
            <Figure minor={l.amountMinor} currency={currency} />
          </td>
        </tr>
      ))}
      <tr>
        <th scope="row" colSpan={2} style={{ textAlign: "end", fontWeight: 600 }}>
          Net cash from {section.label.toLowerCase()}
        </th>
        <td className="sw-num" style={{ fontWeight: 600 }} data-testid={`total-${section.key}`}>
          <Figure minor={section.totalMinor} currency={currency} zero="zero" />
        </td>
      </tr>
    </tbody>
  );
}
