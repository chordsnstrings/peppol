"use client";

import * as React from "react";
import Link from "next/link";
import { api, ApiError, useEntityId, useLedgerQuery } from "@/components/ledger/use-ledger";
import { Figure, PageHead, Panel, ErrorNote, Loading, Empty } from "@/components/ledger/primitives";
import { parseAmount, toInput } from "@/lib/ledger/format";

/**
 * Deferred tax, IAS 12.
 *
 * The register is entered as MAGNITUDES beside the side of the balance sheet
 * the item sits on, and the page signs them before they are stored — an asset
 * positive, a liability negative. That is how IAS 12 itself states the rule
 * (twice, once per side), and it is how a bookkeeper reads a provision: as
 * twenty thousand owed, not as minus twenty thousand. The sign convention is
 * the module's business; asking a person to type a minus is not.
 */

type Category = "FIXED_ASSET" | "PROVISION" | "LEASE" | "LOSS" | "REVENUE" | "OTHER";

const CATEGORIES: { value: Category; label: string; side: "asset" | "liability" }[] = [
  { value: "FIXED_ASSET", label: "Property, plant and equipment", side: "asset" },
  { value: "PROVISION", label: "Provisions and accruals", side: "liability" },
  { value: "LEASE", label: "Leases", side: "asset" },
  { value: "LOSS", label: "Tax losses carried forward", side: "asset" },
  { value: "REVENUE", label: "Revenue taxed in a different period", side: "liability" },
  { value: "OTHER", label: "Other temporary differences", side: "asset" },
];

interface MeasuredItem {
  code: string;
  description: string;
  category: Category;
  side: "asset" | "liability" | "none";
  carryingMinor: string;
  taxBaseMinor: string;
  differenceMinor: string;
  kind: "taxable" | "deductible" | "none";
  rateBps: number;
  unrecognisedMinor: string;
  recognisedDifferenceMinor: string;
  grossTaxMinor: string;
  unrecognisedTaxMinor: string;
  taxMinor: string;
  note: string | null;
}
interface ProposedLine {
  account: string;
  debitMinor: string | null;
  creditMinor: string | null;
  memo: string;
}
interface Position {
  asOf: string;
  currency: string;
  items: MeasuredItem[];
  assetMinor: string;
  liabilityMinor: string;
  netMinor: string;
  offsetBasis: string;
  previous: { asOf: string; assetMinor: string; liabilityMinor: string; netMinor: string } | null;
  movement: {
    fromAsOf: string | null;
    fromNetMinor: string;
    basis: "posted" | "register" | "nil";
    assetMinor: string;
    liabilityMinor: string;
    netMinor: string;
    chargeMinor: string;
    lines: ProposedLine[];
  };
  posted: { asOf: string; entryId: string | null; netMinor: string; chargeMinor: string; stale: boolean } | null;
  unrecognised: { differenceMinor: string; taxMinor: string; count: number };
  warnings: string[];
}
interface NoteRow {
  category: Category;
  label: string;
  openingNetMinor: string;
  closingAssetMinor: string;
  closingLiabilityMinor: string;
  closingNetMinor: string;
  movementMinor: string;
  unrecognisedDifferenceMinor: string;
  unrecognisedTaxMinor: string;
  items: { code: string; description: string; differenceMinor: string; taxMinor: string }[];
}
interface Note {
  asOf: string;
  previousAsOf: string | null;
  rows: NoteRow[];
  totals: {
    openingNetMinor: string;
    closingAssetMinor: string;
    closingLiabilityMinor: string;
    closingNetMinor: string;
    movementMinor: string;
    unrecognisedDifferenceMinor: string;
    unrecognisedTaxMinor: string;
  };
  narrative: string[];
}
interface ReportingDate { asOf: string; items: number; netMinor: string; posted: boolean }
interface Payload { position: Position; note: Note; dates: ReportingDate[] }

interface Derived {
  asOf: string;
  item: { code: string; description: string; category: Category; carryingMinor: string; taxBaseMinor: string; rateBps: number; note?: string };
  taxDepreciationRateBps: number;
  assets: {
    code: string; name: string; acquiredOn: string; monthsHeld: number;
    costMinor: string; carryingMinor: string; taxDepreciationMinor: string;
    taxBaseMinor: string; differenceMinor: string; depreciatedTo: string | null;
  }[];
  totals: { carryingMinor: string; taxBaseMinor: string; differenceMinor: string; taxMinor: string };
  warnings: string[];
}

/** A row as it is edited: magnitudes plus a side, never a typed minus sign. */
interface Draft {
  key: string;
  code: string;
  description: string;
  category: Category;
  side: "asset" | "liability";
  carrying: string;
  taxBase: string;
  ratePct: string;
  unrecognised: string;
  note: string;
}

let seq = 0;
const newKey = () => `r${++seq}`;

const blank = (category: Category = "OTHER"): Draft => ({
  key: newKey(),
  code: "",
  description: "",
  category,
  side: CATEGORIES.find((c) => c.value === category)!.side,
  carrying: "",
  taxBase: "",
  ratePct: "9",
  unrecognised: "",
  note: "",
});

const toDraft = (i: MeasuredItem): Draft => {
  const side = i.carryingMinor.startsWith("-") || i.taxBaseMinor.startsWith("-") ? "liability" : "asset";
  const mag = (v: string) => toInput(v.startsWith("-") ? v.slice(1) : v);
  return {
    key: newKey(),
    code: i.code,
    description: i.description,
    category: i.category,
    side,
    carrying: mag(i.carryingMinor),
    taxBase: mag(i.taxBaseMinor),
    ratePct: (i.rateBps / 100).toString(),
    unrecognised: toInput(i.unrecognisedMinor),
    note: i.note ?? "",
  };
};

/** The end of last month — the reporting date someone is most likely to want. */
function defaultAsOf(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0)).toISOString().slice(0, 10);
}

/** What a draft row means, computed as it is typed. */
function preview(d: Draft) {
  const sign = d.side === "liability" ? -1n : 1n;
  const carrying = parseAmount(d.carrying);
  const taxBase = parseAmount(d.taxBase);
  const unrecognised = parseAmount(d.unrecognised) ?? 0n;
  const pct = Number(d.ratePct);
  const rateBps = Number.isFinite(pct) ? Math.round(pct * 100) : NaN;
  if (carrying === null || taxBase === null || !Number.isInteger(rateBps)) return null;
  const difference = sign * carrying - sign * taxBase;
  const abs = difference < 0n ? -difference : difference;
  const capped = unrecognised > abs ? abs : unrecognised;
  const recognised = abs - capped;
  const tax = (recognised * BigInt(rateBps) + 5000n) / 10000n;
  return {
    carryingMinor: (sign * carrying).toString(),
    taxBaseMinor: (sign * taxBase).toString(),
    rateBps,
    unrecognisedMinor: capped.toString(),
    differenceMinor: difference.toString(),
    kind: difference > 0n ? ("taxable" as const) : difference < 0n ? ("deductible" as const) : ("none" as const),
    taxMinor: (difference > 0n ? tax : -tax).toString(),
  };
}

const KIND_CHIP: Record<"taxable" | "deductible" | "none", string> = {
  taxable: "sw-chip-warn",
  deductible: "sw-chip-ok",
  none: "",
};

export default function DeferredTaxPage() {
  const entityId = useEntityId();
  const [asOf, setAsOf] = React.useState(defaultAsOf);
  const [drafts, setDrafts] = React.useState<Draft[] | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [notices, setNotices] = React.useState<string[]>([]);
  const [depRate, setDepRate] = React.useState("20");
  const [derived, setDerived] = React.useState<Derived | null>(null);

  const { data, error, loading, reload } = useLedgerQuery<Payload>(
    entityId ? `/api/ledger/deferred-tax?entityId=${entityId}&asOf=${asOf}` : null,
    [asOf],
  );

  // The register on screen is reloaded whenever the reporting date changes:
  // each date is its own measurement, so carrying edits across is exactly the
  // mistake the dated register exists to prevent.
  React.useEffect(() => {
    setDrafts(null);
    setDerived(null);
    setNotices([]);
  }, [asOf]);

  const rows = drafts ?? (data ? data.position.items.map(toDraft) : []);
  const edit = (key: string, patch: Partial<Draft>) =>
    setDrafts(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const previews = rows.map(preview);
  const draftAsset = previews.reduce((a, p) => (p && BigInt(p.taxMinor) < 0n ? a - BigInt(p.taxMinor) : a), 0n);
  const draftLiability = previews.reduce((a, p) => (p && BigInt(p.taxMinor) > 0n ? a + BigInt(p.taxMinor) : a), 0n);
  const dirty = drafts !== null;
  const invalid = previews.some((p) => p === null) || rows.some((r) => !r.code.trim() || !r.description.trim());

  const call = async <T,>(label: string, body: Record<string, unknown>): Promise<T | null> => {
    setBusy(label); setErr(null); setMsg(null); setNotices([]);
    try {
      const r = await api<T>("/api/ledger/deferred-tax", {
        method: "POST",
        body: JSON.stringify({ entityId, asOf, ...body }),
      });
      reload();
      return r;
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "That did not work.");
      return null;
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    const items = rows.map((r, i) => {
      const p = previews[i]!;
      return {
        code: r.code.trim(),
        description: r.description.trim(),
        category: r.category,
        carryingMinor: p.carryingMinor,
        taxBaseMinor: p.taxBaseMinor,
        rateBps: p.rateBps,
        unrecognisedMinor: p.unrecognisedMinor,
        ...(r.note.trim() ? { note: r.note.trim() } : {}),
      };
    });
    const r = await call<{ recorded: number; replaced: number; warnings: string[] }>("save", { action: "record", items });
    if (!r) return;
    setDrafts(null);
    setMsg(
      `Measured ${r.recorded} temporary difference${r.recorded === 1 ? "" : "s"} at ${asOf}` +
        (r.replaced ? `, replacing the ${r.replaced} recorded there before.` : "."),
    );
    setNotices(r.warnings);
  };

  const postMovement = async () => {
    const r = await call<{ reference: string | null; chargeMinor: string; netMinor: string; periodLabel: string | null; alreadyPosted: boolean; warnings: string[] }>(
      "post",
      { action: "post" },
    );
    if (!r) return;
    setMsg(
      r.alreadyPosted
        ? `The position at ${asOf} was already on the ledger. Nothing was posted.`
        : r.reference
          ? `Posted ${r.reference} in ${r.periodLabel} — the position at ${asOf} is now on the ledger.`
          : `Nothing needed posting: the position at ${asOf} is the one the ledger already carries.`,
    );
    setNotices(r.warnings);
  };

  const derive = async () => {
    const pct = Number(depRate);
    if (!Number.isFinite(pct)) { setErr("The tax depreciation rate has to be a percentage."); return; }
    setBusy("derive"); setErr(null); setMsg(null);
    try {
      const r = await api<Derived>(
        `/api/ledger/deferred-tax?entityId=${entityId}&asOf=${asOf}&view=derive&taxDepreciationRateBps=${Math.round(pct * 100)}`,
      );
      setDerived(r);
      setNotices(r.warnings);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "That did not work.");
    } finally {
      setBusy(null);
    }
  };

  const takeDerived = () => {
    if (!derived) return;
    const d = derived.item;
    const next = rows.filter((r) => r.code !== d.code);
    setDrafts([
      ...next,
      {
        key: newKey(),
        code: d.code,
        description: d.description,
        category: "FIXED_ASSET",
        side: "asset",
        carrying: toInput(d.carryingMinor),
        taxBase: toInput(d.taxBaseMinor),
        ratePct: (d.rateBps / 100).toString(),
        unrecognised: "",
        note: d.note ?? "",
      },
    ]);
    setDerived(null);
    setMsg(`${d.code} has been put into the register at ${asOf}. Nothing is stored until you save it.`);
  };

  if (!entityId) return <Loading label="Choosing an entity…" />;

  const p = data?.position;
  const currency = p?.currency ?? "AED";
  const charge = p ? BigInt(p.movement.chargeMinor) : 0n;
  const nothingToPost = p !== undefined && p.movement.lines.length === 0;
  const alreadyOn = Boolean(p?.posted?.entryId) && !p?.posted?.stale;

  return (
    <>
      <PageHead
        title="Deferred tax"
        sub={
          "IAS 12 provides for the tax on differences between what the accounts carry an item at and what tax law " +
          "will allow or charge on it later. The register is measured at a reporting date, never accumulated: the " +
          "charge for a period is the movement between two dated positions, so both dates have to survive."
        }
        actions={
          <label className="flex items-center gap-2">
            <span className="sw-label">Reporting date</span>
            <input
              type="date"
              className="sw-input"
              style={{ width: "10rem" }}
              value={asOf}
              onChange={(e) => e.target.value && setAsOf(e.target.value)}
              data-testid="dt-asof"
            />
          </label>
        }
      />

      {data && data.dates.length > 0 && (
        <nav className="mb-3 flex flex-wrap items-center gap-1.5" aria-label="Reporting dates already measured">
          <span className="sw-label">Measured</span>
          {data.dates.map((x) => (
            <button
              key={x.asOf}
              type="button"
              className="sw-btn sw-btn-sm"
              aria-current={x.asOf === asOf ? "true" : undefined}
              onClick={() => setAsOf(x.asOf)}
              data-testid={`dt-date-${x.asOf}`}
            >
              {x.asOf}
              <span className={`sw-chip ${x.posted ? "sw-chip-ok" : "sw-chip-warn"}`} style={{ marginInlineStart: "0.375rem" }}>
                {x.posted ? "posted" : "not posted"}
              </span>
            </button>
          ))}
        </nav>
      )}

      {err && <ErrorNote>{err}</ErrorNote>}
      {msg && <div className="sw-note mb-3" role="status" data-testid="dt-status">{msg}</div>}
      {notices.map((w, i) => (
        <div key={`n${i}`} className="sw-error mb-3" role="alert" data-testid="dt-notice">{w}</div>
      ))}
      {error && <ErrorNote>{error}</ErrorNote>}
      {loading && !data && <Loading />}

      {p && (
        <>
          {p.warnings.map((w, i) => (
            <div key={`w${i}`} className="sw-error mb-3" role="alert" data-testid="dt-warning">{w}</div>
          ))}

          <div className="grid gap-4 lg:grid-cols-2">
            <Panel className="p-4">
              <div className="sw-label">The position at {asOf}</div>
              <table className="sw-table mt-3">
                <caption className="sr-only">Gross deferred tax asset and liability, and the net after offset</caption>
                <tbody>
                  <tr>
                    <td>Gross deferred tax asset</td>
                    <td className="sw-code">1320</td>
                    <td className="sw-num" data-testid="dt-gross-asset">
                      <Figure minor={p.assetMinor} currency={currency} zero="zero" colour={false} />
                    </td>
                  </tr>
                  <tr>
                    <td>Gross deferred tax liability</td>
                    <td className="sw-code">2320</td>
                    <td className="sw-num" data-testid="dt-gross-liability">
                      <Figure minor={p.liabilityMinor} currency={currency} zero="zero" colour={false} />
                    </td>
                  </tr>
                </tbody>
                <tfoot>
                  <tr>
                    <th scope="row" style={{ textAlign: "start" }}>
                      Net {BigInt(p.netMinor) < 0n ? "asset" : "liability"} after offset
                    </th>
                    <td />
                    <td className="sw-num" data-testid="dt-net">
                      <strong><Figure minor={p.netMinor} currency={currency} zero="zero" /></strong>
                    </td>
                  </tr>
                </tfoot>
              </table>
              <p className="sw-sub mt-3 max-w-[70ch]">{p.offsetBasis}</p>
              <p className="sw-sub mt-2">
                A net liability is shown positive and a net asset in parentheses, which is the sign the ledger uses:
                the net goes to <Link href="/accounting/accounts/2320" className="sw-link">2320</Link> when it is a
                liability and to <Link href="/accounting/accounts/1320" className="sw-link">1320</Link> when it is an
                asset. The two gross halves above stay in this register as a disclosure.
              </p>
            </Panel>

            <Panel className="p-4">
              <div className="sw-label">The movement being posted</div>
              <table className="sw-table mt-3">
                <caption className="sr-only">The movement from the previous dated position to this one</caption>
                <tbody>
                  <tr>
                    <td>
                      Position at {p.movement.fromAsOf ?? "the start"}{" "}
                      <span className={`sw-chip ${p.movement.basis === "posted" ? "sw-chip-ok" : p.movement.basis === "register" ? "sw-chip-warn" : ""}`}>
                        {p.movement.basis === "posted" ? "on the ledger" : p.movement.basis === "register" ? "measured, not posted" : "nothing before this"}
                      </span>
                    </td>
                    <td className="sw-num">
                      <Figure minor={p.movement.fromNetMinor} currency={currency} zero="zero" colour={false} />
                    </td>
                  </tr>
                  <tr>
                    <td>Position at {asOf}</td>
                    <td className="sw-num">
                      <Figure minor={p.netMinor} currency={currency} zero="zero" colour={false} />
                    </td>
                  </tr>
                  <tr>
                    <th scope="row" style={{ fontWeight: 600 }}>
                      {charge >= 0n ? "Charged to profit or loss" : "Credited to profit or loss"}
                    </th>
                    <td className="sw-num" data-testid="dt-charge">
                      <strong><Figure minor={p.movement.chargeMinor} currency={currency} zero="zero" /></strong>
                    </td>
                  </tr>
                </tbody>
              </table>

              {p.movement.lines.length > 0 ? (
                <div className="sw-scroll mt-3">
                  <table className="sw-table" data-testid="dt-proposed-lines">
                    <caption className="sr-only">The journal entry this movement would post</caption>
                    <thead>
                      <tr>
                        <th style={{ width: "4rem" }}>Account</th>
                        <th>Line</th>
                        <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Debit</th>
                        <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Credit</th>
                      </tr>
                    </thead>
                    <tbody>
                      {p.movement.lines.map((l, i) => (
                        <tr key={i}>
                          <td className="sw-code">
                            <Link href={`/accounting/accounts/${l.account}`} className="sw-link">{l.account}</Link>
                          </td>
                          <td className="sw-sub">{l.memo}</td>
                          <td className="sw-num">
                            <Figure minor={l.debitMinor ?? 0} currency={currency} colour={false} />
                          </td>
                          <td className="sw-num">
                            <Figure minor={l.creditMinor ?? 0} currency={currency} colour={false} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="sw-sub mt-3">
                  The ledger already carries this position, so there is nothing to post. Re-running changes nothing.
                </p>
              )}

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="sw-btn sw-btn-primary"
                  disabled={busy !== null || nothingToPost || alreadyOn || dirty}
                  aria-disabled={busy !== null || nothingToPost || alreadyOn || dirty || undefined}
                  onClick={postMovement}
                  data-testid="dt-post"
                >
                  {busy === "post" ? "Posting…" : `Post the movement to ${asOf}`}
                </button>
                <span className="sw-sub">
                  {dirty
                    ? "Save the register first — the movement is measured from what is stored, not from what is on screen."
                    : alreadyOn
                      ? "Already on the ledger. A posted entry is reversed, never edited."
                      : "Posted on its own date, so a closed period refuses it in the ledger's own words."}
                </span>
              </div>
            </Panel>
          </div>

          <Panel className="mt-4 overflow-hidden">
            <div
              className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2"
              style={{ borderColor: "var(--sw-line)", background: "var(--sw-surface-2)" }}
            >
              <span className="sw-label">The register at {asOf}</span>
              <span className="sw-sub">
                Enter what the accounts carry and what tax law allows, both as positive amounts, and say which side
                of the balance sheet the item is. The sign is this page&rsquo;s job, not yours.
              </span>
            </div>

            {rows.length === 0 && !dirty ? (
              <div className="p-3">
                <Empty>
                  Nothing has been measured at {asOf}. Add the differences, or derive the fixed asset one below.
                </Empty>
              </div>
            ) : (
              <div className="sw-scroll">
                <table className="sw-table" data-testid="dt-register">
                  <caption className="sr-only">Temporary differences measured at {asOf}</caption>
                  <thead>
                    <tr>
                      <th style={{ width: "7rem" }}>Code</th>
                      <th style={{ minWidth: "12rem" }}>Description</th>
                      <th style={{ width: "13rem" }}>Type</th>
                      <th style={{ width: "6.5rem" }}>Side</th>
                      <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Carrying</th>
                      <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Tax base</th>
                      <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Difference</th>
                      <th style={{ width: "7rem" }}>Effect</th>
                      <th className="sw-num" style={{ width: "4.5rem" }}>Rate</th>
                      <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Unrecognised</th>
                      <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Deferred tax</th>
                      <th style={{ width: "3rem" }}><span className="sr-only">Remove</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => {
                      const v = previews[i];
                      return (
                        <tr key={r.key} data-testid={`dt-row-${r.code || r.key}`}>
                          <td>
                            <input
                              className="sw-cell"
                              aria-label={`Code for row ${i + 1}`}
                              value={r.code}
                              onChange={(e) => edit(r.key, { code: e.target.value })}
                            />
                          </td>
                          <td>
                            <input
                              className="sw-cell"
                              aria-label={`Description for row ${i + 1}`}
                              value={r.description}
                              onChange={(e) => edit(r.key, { description: e.target.value })}
                            />
                          </td>
                          <td>
                            <select
                              className="sw-select sw-select-sm"
                              aria-label={`Type of difference for row ${i + 1}`}
                              value={r.category}
                              onChange={(e) => {
                                const category = e.target.value as Category;
                                edit(r.key, { category, side: CATEGORIES.find((c) => c.value === category)!.side });
                              }}
                            >
                              {CATEGORIES.map((c) => (
                                <option key={c.value} value={c.value}>{c.label}</option>
                              ))}
                            </select>
                          </td>
                          <td>
                            <select
                              className="sw-select sw-select-sm"
                              aria-label={`Balance sheet side for row ${i + 1}`}
                              value={r.side}
                              onChange={(e) => edit(r.key, { side: e.target.value as "asset" | "liability" })}
                            >
                              <option value="asset">Asset</option>
                              <option value="liability">Liability</option>
                            </select>
                          </td>
                          <td>
                            <input
                              className="sw-cell sw-cell-num"
                              inputMode="decimal"
                              aria-label={`Carrying amount for row ${i + 1}`}
                              value={r.carrying}
                              onChange={(e) => edit(r.key, { carrying: e.target.value })}
                            />
                          </td>
                          <td>
                            <input
                              className="sw-cell sw-cell-num"
                              inputMode="decimal"
                              aria-label={`Tax base for row ${i + 1}`}
                              value={r.taxBase}
                              onChange={(e) => edit(r.key, { taxBase: e.target.value })}
                            />
                          </td>
                          <td className="sw-num">
                            {v ? <Figure minor={v.differenceMinor} currency={currency} /> : <span className="sw-zero">–</span>}
                          </td>
                          <td>
                            {v && (
                              <span className={`sw-chip ${KIND_CHIP[v.kind]}`}>
                                {v.kind === "taxable" ? "liability" : v.kind === "deductible" ? "asset" : "none"}
                              </span>
                            )}
                          </td>
                          <td>
                            <input
                              className="sw-cell sw-cell-num"
                              inputMode="decimal"
                              aria-label={`Rate for row ${i + 1}, as a percentage`}
                              value={r.ratePct}
                              onChange={(e) => edit(r.key, { ratePct: e.target.value })}
                            />
                          </td>
                          <td>
                            <input
                              className="sw-cell sw-cell-num"
                              inputMode="decimal"
                              aria-label={`Unrecognised amount for row ${i + 1}`}
                              value={r.unrecognised}
                              onChange={(e) => edit(r.key, { unrecognised: e.target.value })}
                            />
                          </td>
                          <td className="sw-num" data-testid={`dt-tax-${r.code || r.key}`}>
                            {v ? <Figure minor={v.taxMinor} currency={currency} /> : <span className="sw-zero">–</span>}
                          </td>
                          <td>
                            <button
                              type="button"
                              className="sw-btn sw-btn-sm"
                              onClick={() => setDrafts(rows.filter((x) => x.key !== r.key))}
                              aria-label={`Remove ${r.code || `row ${i + 1}`}`}
                            >
                              ×
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr>
                      <th scope="row" colSpan={10} style={{ textAlign: "start" }}>
                        Gross asset <Figure minor={(-draftAsset).toString()} currency={currency} zero="zero" /> and
                        gross liability <Figure minor={draftLiability.toString()} currency={currency} zero="zero" colour={false} />
                      </th>
                      <td className="sw-num" data-testid="dt-draft-net">
                        <strong><Figure minor={(draftLiability - draftAsset).toString()} currency={currency} zero="zero" /></strong>
                      </td>
                      <td />
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2 border-t p-3" style={{ borderColor: "var(--sw-line)" }}>
              <button
                type="button"
                className="sw-btn"
                onClick={() => setDrafts([...rows, blank()])}
                data-testid="dt-add-row"
              >
                Add a difference
              </button>
              <button
                type="button"
                className="sw-btn sw-btn-primary"
                disabled={!dirty || invalid || busy !== null}
                aria-disabled={!dirty || invalid || busy !== null || undefined}
                onClick={save}
                data-testid="dt-save"
              >
                {busy === "save" ? "Saving…" : `Measure ${asOf}`}
              </button>
              {dirty && (
                <button type="button" className="sw-btn" onClick={() => setDrafts(null)}>Discard changes</button>
              )}
              <span className="sw-sub">
                {invalid
                  ? "Every row needs a code, a description and amounts that are amounts."
                  : "Saving replaces everything measured at this date. A reporting date is measured once, in full."}
              </span>
            </div>
          </Panel>

          <Panel className="mt-4 p-4">
            <div className="sw-label">Derive the fixed asset difference from the register</div>
            <p className="sw-sub mt-1.5 max-w-[70ch]">
              Accounting depreciation against tax depreciation is the largest temporary difference in most UAE
              entities, and the one nobody should be retyping.{" "}
              <strong>UAE tax depreciation rules are not implemented here.</strong> Federal Decree-Law 47/2022 starts
              from accounting profit and has no separate capital allowance code, so for many entities the two
              depreciations are the same and this difference is nil. The rate below is your assumption; the software
              applies it faithfully and does not endorse it.
            </p>
            <div className="mt-3 flex flex-wrap items-end gap-3">
              <label className="block">
                <span className="sw-label">Tax depreciation (% a year, on cost)</span>
                <input
                  className="sw-input sw-cell-num mt-1"
                  style={{ width: "8rem" }}
                  inputMode="decimal"
                  value={depRate}
                  onChange={(e) => setDepRate(e.target.value)}
                  data-testid="dt-dep-rate"
                />
              </label>
              <button
                type="button"
                className="sw-btn"
                disabled={busy !== null}
                aria-disabled={busy !== null || undefined}
                onClick={derive}
                data-testid="dt-derive"
              >
                {busy === "derive" ? "Reading the register…" : "Derive at this date"}
              </button>
            </div>

            {derived && (
              <>
                <div className="sw-scroll mt-3">
                  <table className="sw-table" data-testid="dt-derived">
                    <caption className="sr-only">Fixed assets, their carrying amounts and their assumed tax bases</caption>
                    <thead>
                      <tr>
                        <th style={{ width: "6rem" }}>Asset</th>
                        <th>Name</th>
                        <th style={{ width: "6.5rem" }}>Acquired</th>
                        <th className="sw-num" style={{ width: "4rem" }}>Months</th>
                        <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Cost</th>
                        <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Carrying</th>
                        <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Tax base</th>
                        <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Difference</th>
                      </tr>
                    </thead>
                    <tbody>
                      {derived.assets.map((a) => (
                        <tr key={a.code}>
                          <td className="sw-code">{a.code}</td>
                          <td>{a.name}</td>
                          <td className="sw-sub">{a.acquiredOn}</td>
                          <td className="sw-num">{a.monthsHeld}</td>
                          <td className="sw-num"><Figure minor={a.costMinor} currency={currency} colour={false} /></td>
                          <td className="sw-num"><Figure minor={a.carryingMinor} currency={currency} colour={false} /></td>
                          <td className="sw-num"><Figure minor={a.taxBaseMinor} currency={currency} colour={false} /></td>
                          <td className="sw-num"><Figure minor={a.differenceMinor} currency={currency} /></td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <th scope="row" colSpan={5} style={{ textAlign: "start" }}>
                          Temporary difference, and the deferred tax on it
                        </th>
                        <td className="sw-num"><Figure minor={derived.totals.carryingMinor} currency={currency} colour={false} /></td>
                        <td className="sw-num"><Figure minor={derived.totals.taxBaseMinor} currency={currency} colour={false} /></td>
                        <td className="sw-num" data-testid="dt-derived-tax">
                          <strong><Figure minor={derived.totals.taxMinor} currency={currency} zero="zero" /></strong>
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <button type="button" className="sw-btn" onClick={takeDerived} data-testid="dt-take-derived">
                    Put {derived.item.code} into the register
                  </button>
                  <span className="sw-sub">
                    Nothing has been stored. It goes into the rows above, replacing any row with the same code, and
                    is written only when you measure the date.
                  </span>
                </div>
              </>
            )}
          </Panel>

          {data?.note && (
            <Panel className="mt-4 overflow-hidden">
              <div className="border-b px-3 py-2" style={{ borderColor: "var(--sw-line)", background: "var(--sw-surface-2)" }}>
                <span className="sw-label">
                  The note — IAS 12.81(g), by type of temporary difference
                </span>
              </div>
              <div className="sw-scroll">
                <table className="sw-table" data-testid="dt-note">
                  <caption className="sr-only">Deferred tax by type of temporary difference, and the movement in each</caption>
                  <thead>
                    <tr>
                      <th>Type of difference</th>
                      <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>
                        At {data.note.previousAsOf ?? "the start"}
                      </th>
                      <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Movement</th>
                      <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Asset</th>
                      <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Liability</th>
                      <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>At {asOf}</th>
                      <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Unrecognised</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.note.rows.map((r) => (
                      <tr key={r.category} data-testid={`dt-note-${r.category}`}>
                        <td>
                          {r.label}
                          {r.items.length > 0 && (
                            <span className="sw-sub" style={{ display: "block" }}>
                              {r.items.map((i) => i.code).join(", ")}
                            </span>
                          )}
                        </td>
                        <td className="sw-num"><Figure minor={r.openingNetMinor} currency={currency} /></td>
                        <td className="sw-num"><Figure minor={r.movementMinor} currency={currency} /></td>
                        <td className="sw-num"><Figure minor={r.closingAssetMinor} currency={currency} colour={false} /></td>
                        <td className="sw-num"><Figure minor={r.closingLiabilityMinor} currency={currency} colour={false} /></td>
                        <td className="sw-num"><Figure minor={r.closingNetMinor} currency={currency} /></td>
                        <td className="sw-num"><Figure minor={r.unrecognisedTaxMinor} currency={currency} colour={false} /></td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <th scope="row" style={{ textAlign: "start" }}>Net deferred tax</th>
                      <td className="sw-num"><Figure minor={data.note.totals.openingNetMinor} currency={currency} zero="zero" /></td>
                      <td className="sw-num" data-testid="dt-note-movement">
                        <Figure minor={data.note.totals.movementMinor} currency={currency} zero="zero" />
                      </td>
                      <td className="sw-num"><Figure minor={data.note.totals.closingAssetMinor} currency={currency} zero="zero" colour={false} /></td>
                      <td className="sw-num"><Figure minor={data.note.totals.closingLiabilityMinor} currency={currency} zero="zero" colour={false} /></td>
                      <td className="sw-num" data-testid="dt-note-net">
                        <strong><Figure minor={data.note.totals.closingNetMinor} currency={currency} zero="zero" /></strong>
                      </td>
                      <td className="sw-num"><Figure minor={data.note.totals.unrecognisedTaxMinor} currency={currency} zero="zero" colour={false} /></td>
                    </tr>
                  </tfoot>
                </table>
              </div>
              <div className="border-t p-3" style={{ borderColor: "var(--sw-line)" }}>
                {data.note.narrative.map((s, i) => (
                  <p key={i} className="sw-sub max-w-[80ch]" style={{ marginBlockStart: i ? "0.5rem" : 0 }}>{s}</p>
                ))}
              </div>
            </Panel>
          )}

          <p className="sw-sub mt-3" data-testid="dt-scope">
            Deferred tax is measured at the rate expected when each difference reverses (IAS 12.47) and is never
            discounted (IAS 12.53). The initial recognition exemption, investments in subsidiaries and associates,
            tax groups and Qualifying Free Zone Persons are not modelled. The current tax on this period&rsquo;s
            income is computed separately, on{" "}
            <Link href="/accounting/corporate-tax" className="sw-link">the corporate tax page</Link>.
          </p>
        </>
      )}
    </>
  );
}
