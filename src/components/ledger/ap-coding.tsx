"use client";

import * as React from "react";
import { metaGet, metaSet } from "@/lib/db/database";
import { useLedgerQuery } from "./use-ledger";
import type { Invoice, InvoiceLine, TaxProfileCode } from "@/lib/domain/types";

/**
 * Where a supplier bill lands, and how the screen remembers.
 *
 * A bill arrives as a document: a supplier, a number, some lines and a total.
 * None of that says which cost the business has incurred, and the ledger
 * cannot guess — `postBill` routes a line wherever its caller says and falls
 * back to other operating expenses, which is honest but useless as a set of
 * accounts. Coding is the decision a person makes, so the screen has to ask
 * for it, and asking forty times for the same answer is how a screen gets
 * abandoned. Hence the memory below.
 *
 * The three payables panels share the pieces here — the chart, the picker, the
 * memory and the small labelled field — because they are three parts of one
 * screen rather than three screens of their own.
 */

export interface ChartAccount {
  id: string;
  code: string;
  name: string;
  nameAr: string | null;
  type: string;
  subtype: string | null;
  isPostable: boolean;
  isControl: boolean;
  status: string;
}

/**
 * The account a line goes to when neither this description nor this supplier
 * has been coded before.
 *
 * It mirrors `EXPENSE_BY_PROFILE` in src/lib/server/ledger/ap.ts, and the
 * duplication is deliberate rather than an oversight: the picker has to show
 * the account it is about to use, and a default the screen cannot see is a
 * default nobody checks. The two tables cannot silently drift apart into two
 * different postings, because the screen always sends an account for every
 * line — what posts is what the picker says, not this table read again on the
 * server.
 */
const DEFAULT_ACCOUNT: Record<TaxProfileCode, string> = {
  STANDARD_5: "6900",
  ZERO_EXPORT: "6900",
  ZERO_OTHER: "6900",
  EXEMPT: "6900",
  OUT_OF_SCOPE: "6900",
  REVERSE_CHARGE: "6250", // typically imported professional services
  DESIGNATED_ZONE: "6900",
  MARGIN_SCHEME: "6900",
};

/**
 * Accounts a purchase line may not be coded to, though they are postable.
 *
 * 1350 carries the recoverable input VAT and `postBill` posts that leg itself
 * from the tax on the lines; coding a line there would put the tax in twice.
 * 1100 is the other side of the book entirely — money owed TO the business —
 * and a bill that landed there would net a supplier's invoice against a
 * customer's. Neither is a judgement about the account; both are already
 * spoken for on this posting path.
 */
const SPOKEN_FOR = new Set(["1350", "1100"]);

/** The chart, narrowed to what a bill can honestly be charged to. */
export function usePurchaseAccounts(entityId: string | undefined) {
  const q = useLedgerQuery<{ accounts: ChartAccount[] }>(
    entityId ? `/api/ledger/accounts?entityId=${entityId}&postable=1` : null,
  );
  const accounts = React.useMemo(
    () =>
      (q.data?.accounts ?? []).filter(
        // Costs and the balance-sheet lines a purchase can capitalise into —
        // stock, a prepayment, a fixed asset. Income and equity are not places
        // a supplier's invoice can land, and offering them is how they get
        // picked at four in the afternoon.
        (a) => (a.type === "EXPENSE" || a.type === "ASSET") && !SPOKEN_FOR.has(a.code),
      ),
    [q.data],
  );
  return { accounts, error: q.error, loading: q.loading };
}

/** Bank and cash accounts — where a supplier payment can leave from. */
export function usePaymentAccounts(entityId: string | undefined) {
  const q = useLedgerQuery<{ accounts: ChartAccount[] }>(
    entityId ? `/api/ledger/accounts?entityId=${entityId}&postable=1` : null,
  );
  const accounts = React.useMemo(
    () => (q.data?.accounts ?? []).filter((a) => a.subtype === "BANK" || a.subtype === "CASH"),
    [q.data],
  );
  return { accounts, error: q.error, loading: q.loading };
}

/* ----------------------------------------------------------------- memory --- */

export interface CodingMemory {
  /** A line description, folded, to the account it was coded to last time. */
  byDescription: Record<string, string>;
  /** A supplier name, folded, to the account most of its money went to. */
  bySupplier: Record<string, string>;
}

const EMPTY_MEMORY: CodingMemory = { byDescription: {}, bySupplier: {} };

const fold = (s: string) => s.trim().toLowerCase();
const memoryKey = (entityId: string) => `ap-coding:${entityId}`;

/**
 * What this person coded the last bill like this to.
 *
 * It lives in the per-user meta store, so it is one bookkeeper's habit rather
 * than the entity's policy — which is why the panel says "coded like last
 * time" and never "the supplier's account". A shared default would be a
 * different feature with a different home; claiming this is one would be a
 * sentence the code has not earned.
 */
export function useCodingMemory(entityId: string | undefined) {
  const [memory, setMemory] = React.useState<CodingMemory>(EMPTY_MEMORY);
  /* Whether the read has finished, however it finished. A panel that seeded
   * its pickers from an empty memory would fill every line with the treatment
   * default a moment before the remembered accounts arrived, and then have no
   * blank left to put them in. */
  const [ready, setReady] = React.useState(false);

  React.useEffect(() => {
    if (!entityId) return;
    let cancelled = false;
    setReady(false);
    metaGet<CodingMemory>(memoryKey(entityId))
      .then((v) => {
        if (cancelled || !v) return;
        setMemory({ byDescription: v.byDescription ?? {}, bySupplier: v.bySupplier ?? {} });
      })
      // A memory that cannot be read costs a prefilled dropdown and nothing
      // else, so it must never be able to stop a bill being coded.
      .catch(() => undefined)
      .finally(() => { if (!cancelled) setReady(true); });
    return () => { cancelled = true; };
  }, [entityId]);

  const remember = React.useCallback(
    async (bill: Invoice, coding: Record<string, string>) => {
      if (!entityId) return;
      const next: CodingMemory = {
        byDescription: { ...memory.byDescription },
        bySupplier: { ...memory.bySupplier },
      };
      let biggest: { net: number; account: string } | null = null;
      for (const line of bill.lines) {
        const account = coding[line.id];
        if (!account) continue;
        if (line.description.trim()) next.byDescription[fold(line.description)] = account;
        const net = Math.abs(line.lineNetMinor);
        if (!biggest || net > biggest.net) biggest = { net, account };
      }
      // One account per supplier, and it is the one most of the bill went to.
      // A supplier whose bills are split three ways every month is a supplier
      // the description memory answers better anyway.
      const supplier = bill.seller?.nameEn ?? "";
      if (biggest && supplier.trim()) next.bySupplier[fold(supplier)] = biggest.account;
      setMemory(next);
      await metaSet(memoryKey(entityId), next).catch(() => undefined);
    },
    [entityId, memory],
  );

  return { memory, remember, ready };
}

/**
 * The account to open a line on: what this description was coded to last time,
 * else what this supplier's money usually goes to, else the treatment's
 * default. A remembered code that has since left the chart is dropped rather
 * than shown — a picker holding a value that is not one of its options silently
 * selects the first one instead, which is how a rent bill ends up in stock.
 */
export function suggestAccount(
  memory: CodingMemory,
  bill: Invoice,
  line: InvoiceLine,
  accounts: ChartAccount[],
): string {
  const known = new Set(accounts.map((a) => a.code));
  const candidates = [
    memory.byDescription[fold(line.description)],
    memory.bySupplier[fold(bill.seller?.nameEn ?? "")],
    DEFAULT_ACCOUNT[line.taxProfileCode],
  ];
  return candidates.find((c) => c && known.has(c)) ?? "";
}

/* ------------------------------------------------------------------ pieces --- */

/** A labelled control. Every panel on this screen uses it; nothing else does. */
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="sw-label">{label}</span>
      <span className="mt-1 block">{children}</span>
      {hint && <span className="sw-sub mt-1 block">{hint}</span>}
    </label>
  );
}

/**
 * The account picker.
 *
 * Grouped by what the account IS — a cost of this month, or something the
 * business still holds — because that is the only question a person coding a
 * bill is actually answering, and the codes are meaningless to anybody who has
 * not learnt this chart.
 */
export function AccountSelect({
  accounts,
  value,
  onChange,
  ariaLabel,
  inGrid = false,
}: {
  accounts: ChartAccount[];
  value: string;
  onChange: (code: string) => void;
  ariaLabel: string;
  /** Chromeless, for a cell inside an entry grid — the grid lines say where it is. */
  inGrid?: boolean;
}) {
  const expenses = accounts.filter((a) => a.type === "EXPENSE");
  const assets = accounts.filter((a) => a.type === "ASSET");
  return (
    <select
      className={inGrid ? "sw-cell" : "sw-select"}
      value={value}
      aria-label={ariaLabel}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">Choose an account…</option>
      {expenses.length > 0 && (
        <optgroup label="Cost">
          {expenses.map((a) => (
            <option key={a.id} value={a.code}>{a.code} · {a.name}</option>
          ))}
        </optgroup>
      )}
      {assets.length > 0 && (
        <optgroup label="Still held">
          {assets.map((a) => (
            <option key={a.id} value={a.code}>{a.code} · {a.name}</option>
          ))}
        </optgroup>
      )}
    </select>
  );
}

/* ------------------------------------------------------------- arithmetic --- */

/**
 * The sum `postBill` will check the bill against, and the total it will check
 * it against — recomputed here so the screen can say what is about to happen
 * before it happens.
 *
 * The check on the server is `sum(line net) + sum(line VAT, excluding reverse
 * charge) === totals.payableMinor`, and the two sides can disagree by a fils
 * on a document nobody keyed wrong: `computeTotals` rounds VAT once per rate,
 * as EN 16931 requires, while the posting check adds up the per-line figures.
 * Two lines at the same rate that each round half a fils up are a fils the
 * ledger will not accept. Saying so before the request is sent is the whole
 * value of computing it twice.
 */
export function postingArithmetic(bill: Pick<Invoice, "lines" | "totals">): {
  linesMinor: bigint;
  payableMinor: bigint;
  driftMinor: bigint;
} {
  const net = bill.lines.reduce((a, l) => a + BigInt(l.lineNetMinor), 0n);
  const chargedVat = bill.lines
    .filter((l) => l.taxProfileCode !== "REVERSE_CHARGE")
    .reduce((a, l) => a + BigInt(l.lineVatMinor), 0n);
  const payableMinor = BigInt(bill.totals.payableMinor);
  return { linesMinor: net + chargedVat, payableMinor, driftMinor: net + chargedVat - payableMinor };
}

/**
 * Minor units into a JSON number, or null when they will not fit one.
 *
 * The document store and the AP posting route both carry amounts as JSON
 * numbers, so this is the boundary where a BigInt has to become one. Above
 * 2^53 minor units a JavaScript number stops being able to hold every integer,
 * and the failure is silent — the amount posts, one fils out. Returning null
 * lets the caller refuse instead, which for a figure this side of ninety
 * trillion fils will never happen and is exactly why it must be checked.
 */
export function toWireMinor(v: bigint): number | null {
  return v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= -BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : null;
}
