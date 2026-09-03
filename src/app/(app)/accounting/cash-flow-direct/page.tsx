"use client";

import * as React from "react";
import { useEntityId, useLedgerQuery } from "@/components/ledger/use-ledger";
import { Figure, PageHead, Panel, ErrorNote, Loading, Empty } from "@/components/ledger/primitives";

interface Row { line: string; label: string; amountMinor: string }
interface Direct {
  from: string; to: string; currency: string;
  operating: Row[];
  netOperatingMinor: string;
  investingMinor: string;
  financingMinor: string;
  unattributedMinor: string;
  netCashMovementMinor: string;
  cashMovementPerLedgerMinor: string;
  reconciles: boolean;
  differenceMinor: string;
  reconciliation: {
    netOperatingIndirectMinor: string;
    agreesWithDirect: boolean;
    differenceMinor: string;
  };
  mixedEntries: number;
  warnings: string[];
}

const yearStart = () => `${new Date().getUTCFullYear()}-01-01`;
const today = () => new Date().toISOString().slice(0, 10);

export default function DirectCashFlowPage() {
  const entityId = useEntityId();
  const [from, setFrom] = React.useState(yearStart);
  const [to, setTo] = React.useState(today);

  const { data, error, loading } = useLedgerQuery<Direct>(
    entityId ? `/api/ledger/cash-flow-direct?entityId=${entityId}&from=${from}&to=${to}` : null,
    [from, to],
  );

  if (!entityId) return <Loading label="Choosing an entity…" />;

  return (
    <>
      <PageHead
        title="Cash flow — direct method"
        sub={
          "IAS 7.19 encourages this presentation, because “cash received from customers” is a figure a " +
          "reader can act on and “profit adjusted for depreciation and the movement in receivables” is a " +
          "figure a reader has to unpick. Every movement on a cash account is attributed to the contra accounts of " +
          "its own journal entry — the cash line never says what it was for, the rest of the entry does."
        }
        actions={
          <>
            <label className="flex items-center gap-1.5">
              <span className="sw-label">From</span>
              <input type="date" className="sw-input" style={{ width: "10rem" }} value={from}
                onChange={(e) => setFrom(e.target.value)} aria-label="Period from" />
            </label>
            <label className="flex items-center gap-1.5">
              <span className="sw-label">To</span>
              <input type="date" className="sw-input" style={{ width: "10rem" }} value={to}
                onChange={(e) => setTo(e.target.value)} aria-label="Period to" />
            </label>
          </>
        }
      />

      {error && <ErrorNote>{error}</ErrorNote>}
      {loading && !data && <Loading />}

      {data && (
        <>
          {data.warnings.length > 0 && (
            <Panel className="mb-4 p-4">
              <div className="sw-label">What is worth knowing about these figures</div>
              <ul className="mt-2 space-y-1" data-testid="direct-warnings">
                {data.warnings.map((w) => (
                  <li key={w} className="sw-sub" style={{ color: "var(--sw-warn)" }}>{w}</li>
                ))}
              </ul>
            </Panel>
          )}

          {data.operating.length === 0 && data.investingMinor === "0" && data.financingMinor === "0" ? (
            <Empty>No cash moved between {data.from} and {data.to}.</Empty>
          ) : (
            <Panel className="mb-4 overflow-hidden">
              <div className="sw-scroll">
                <table className="sw-table">
                  <caption className="sr-only">Cash flows by the direct method</caption>
                  <thead>
                    <tr>
                      <th>What the cash was for</th>
                      <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>{data.currency}</th>
                    </tr>
                  </thead>
                  <tbody data-testid="direct-rows">
                    {data.operating.map((r) => (
                      <tr key={r.line}>
                        <td>{r.label}</td>
                        <td className="sw-num"><Figure minor={r.amountMinor} /></td>
                      </tr>
                    ))}
                    <tr>
                      <th scope="row">Net cash from operating activities</th>
                      <th className="sw-num" data-testid="net-operating">
                        <Figure minor={data.netOperatingMinor} />
                      </th>
                    </tr>
                    <tr>
                      <td>Investing</td>
                      <td className="sw-num"><Figure minor={data.investingMinor} /></td>
                    </tr>
                    <tr>
                      <td>Financing</td>
                      <td className="sw-num"><Figure minor={data.financingMinor} /></td>
                    </tr>
                    {data.unattributedMinor !== "0" && (
                      <tr>
                        <td>
                          Not attributed
                          <span className="sw-sub"> — cash on an entry with no other line</span>
                        </td>
                        <td className="sw-num"><Figure minor={data.unattributedMinor} /></td>
                      </tr>
                    )}
                  </tbody>
                  <tfoot>
                    <tr>
                      <th scope="row">Net movement in cash</th>
                      <th className="sw-num"><Figure minor={data.netCashMovementMinor} /></th>
                    </tr>
                    <tr>
                      <th scope="row" className="sw-sub">The same movement, read from the ledger</th>
                      <th className="sw-num sw-sub"><Figure minor={data.cashMovementPerLedgerMinor} /></th>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </Panel>
          )}

          <Panel className="mb-4 p-4">
            <div className="sw-label">Proofs</div>
            <dl className="mt-3 grid gap-4 sm:grid-cols-2">
              <div>
                <dt className="sw-sub">Does the statement account for every dirham of cash?</dt>
                <dd className="mt-1" role="status" data-testid="direct-reconciles">
                  {data.reconciles ? (
                    <span className="sw-chip">yes</span>
                  ) : (
                    <>
                      <span className="sw-chip sw-chip-bad">no</span>{" "}
                      <span className="sw-num">
                        out by <Figure minor={data.differenceMinor} />
                      </span>
                    </>
                  )}
                </dd>
              </div>
              <div>
                <dt className="sw-sub">
                  Does it agree with the indirect statement? IAS 7.20 asks for both, and they have to agree.
                </dt>
                <dd className="mt-1" role="status" data-testid="direct-agrees">
                  {data.reconciliation.agreesWithDirect ? (
                    <span className="sw-chip">yes</span>
                  ) : (
                    <>
                      <span className="sw-chip sw-chip-bad">no</span>{" "}
                      <span className="sw-num">
                        indirect says{" "}
                        <Figure minor={data.reconciliation.netOperatingIndirectMinor} />
                      </span>
                    </>
                  )}
                </dd>
              </div>
            </dl>
          </Panel>

          <p className="sw-sub max-w-[75ch]">
            Payments are negative figures rather than positive ones under a &ldquo;payments&rdquo; heading. The
            statement adds up, and it adds up because the signs are real — a column of positive numbers under two
            different headings is a column a reader has to know the convention of before they can total it.
          </p>
          <p className="sw-sub mt-2 max-w-[75ch]">
            {data.mixedEntries === 0
              ? "Every entry's cash went to contra lines of one character, so nothing here is an apportionment."
              : `${data.mixedEntries} ${data.mixedEntries === 1 ? "entry had its" : "entries had their"} cash split ` +
                `across contra lines of differing character. The split is by amount, which is arithmetic rather ` +
                `than fact: it is right where the lines are alike, as they are on a payment run, and approximate ` +
                `where they are not.`}
          </p>
        </>
      )}
    </>
  );
}
