"use client";

import * as React from "react";
import Link from "next/link";
import { useEntityId, useLedgerQuery, api, ApiError } from "@/components/ledger/use-ledger";
import { Figure, PageHead, Panel, ErrorNote, Loading, StatusChip } from "@/components/ledger/primitives";

interface Period { id: string; label: string; status: string; startsOn: string; endsOn: string; isAdjustment: boolean }
interface TB { currency: string; periodLabel: string; totalDebitMinor: string; totalCreditMinor: string; differenceMinor: string; balanced: boolean; rows: unknown[] }

export default function AccountingOverview() {
  const entityId = useEntityId();
  const periods = useLedgerQuery<{ periods: Period[] }>(entityId ? `/api/ledger/periods?entityId=${entityId}` : null);
  const [opening, setOpening] = React.useState(false);
  const [setupError, setSetupError] = React.useState<string | null>(null);

  // The period covering today is the one a person means by "now".
  const today = new Date().toISOString().slice(0, 10);
  const all = periods.data?.periods ?? [];
  const open =
    all.find((p) => today >= p.startsOn.slice(0, 10) && today <= p.endsOn.slice(0, 10) && !p.isAdjustment) ??
    all.find((p) => p.status === "open");
  const tb = useLedgerQuery<TB>(
    entityId && open ? `/api/ledger/trial-balance?entityId=${entityId}&period=${encodeURIComponent(open.label)}` : null,
  );

  const openBooks = async () => {
    if (!entityId) return;
    setOpening(true);
    setSetupError(null);
    try {
      await api("/api/ledger/setup", { method: "POST", body: JSON.stringify({ entityId }) });
      periods.reload();
    } catch (e) {
      setSetupError(e instanceof ApiError ? e.message : "Could not open the books.");
    } finally {
      setOpening(false);
    }
  };

  if (!entityId) return <Loading label="Choosing an entity…" />;

  const hasBooks = (periods.data?.periods.length ?? 0) > 0;

  return (
    <>
      <PageHead
        title="Accounting"
        sub="A real double-entry general ledger. Every figure below is summed from posted journal lines — nothing here is a stored total that can drift away from the entries behind it."
      />

      {periods.error && <ErrorNote>{periods.error}</ErrorNote>}
      {setupError && <ErrorNote>{setupError}</ErrorNote>}

      {periods.loading && <Loading />}

      {!periods.loading && !hasBooks && (
        <Panel className="p-5">
          <h2 className="text-[0.9375rem] font-semibold">The books are not open yet</h2>
          <p className="sw-sub mt-1.5 max-w-[60ch]">
            Opening the books creates a fiscal year with twelve monthly periods plus a year-end
            adjustment period, a primary book in AED, and a UAE chart of accounts you can extend.
            Nothing is posted — you start from a clean, balanced ledger.
          </p>
          <button
            className="sw-btn sw-btn-primary mt-4"
            onClick={openBooks}
            aria-disabled={opening || undefined}
            disabled={opening}
          >
            {opening ? "Opening…" : "Open the books"}
          </button>
        </Panel>
      )}

      {hasBooks && (
        <div className="grid gap-4 md:grid-cols-3">
          <Panel className="p-4 md:col-span-2">
            <div className="sw-label">Trial balance{open ? ` — ${open.label}` : ""}</div>
            {tb.loading && <Loading />}
            {tb.error && <p className="sw-sub mt-2">{tb.error}</p>}
            {tb.data && (
              <>
                <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-3">
                  <Stat label="Total debits" value={<Figure minor={tb.data.totalDebitMinor} currency={tb.data.currency} colour={false} />} />
                  <Stat label="Total credits" value={<Figure minor={tb.data.totalCreditMinor} currency={tb.data.currency} colour={false} />} />
                  <Stat
                    label="Difference"
                    value={
                      tb.data.balanced ? (
                        <span className="sw-zero">–</span>
                      ) : (
                        <Figure minor={tb.data.differenceMinor} currency={tb.data.currency} />
                      )
                    }
                  />
                </div>
                <p className="sw-sub mt-3">
                  {tb.data.balanced
                    ? "Debits equal credits. The ledger is balanced."
                    : "The ledger is out of balance. This should be impossible — the database refuses an unbalanced entry — so please report it."}
                </p>
                <Link href="/accounting/trial-balance" className="sw-link mt-3 inline-block text-[0.8125rem]">
                  Open the full trial balance
                </Link>
              </>
            )}
          </Panel>

          <Panel className="p-4">
            <div className="sw-label">Periods</div>
            <ul className="mt-2.5 space-y-1.5">
              {(periods.data?.periods ?? []).slice(0, 6).map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-2 text-[0.8125rem]">
                  <span>{p.label}</span>
                  <StatusChip status={p.status} />
                </li>
              ))}
            </ul>
            <Link href="/accounting/periods" className="sw-link mt-3 inline-block text-[0.8125rem]">
              All periods and closing
            </Link>
          </Panel>

          <Panel className="p-4 md:col-span-3">
            <div className="sw-label">Next</div>
            <div className="mt-2.5 flex flex-wrap gap-2">
              <Link href="/accounting/journals/new" className="sw-btn sw-btn-primary">New journal entry</Link>
              <Link href="/accounting/accounts" className="sw-btn">Chart of accounts</Link>
              <Link href="/accounting/journals" className="sw-btn">Journal register</Link>
            </div>
          </Panel>
        </div>
      )}
    </>
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
