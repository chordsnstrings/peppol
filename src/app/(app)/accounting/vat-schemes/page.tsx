"use client";

import * as React from "react";
import Link from "next/link";
import { api, ApiError, useEntityId, useLedgerQuery } from "@/components/ledger/use-ledger";
import { Figure, PageHead, Panel, ErrorNote, Loading, Empty, StatusChip } from "@/components/ledger/primitives";
import { parseAmount, toInput } from "@/lib/ledger/format";

/**
 * The three VAT treatments the return cannot express on its own.
 *
 * The screen is arranged around the one that gets missed. The capital assets
 * scheme falls due years after a purchase everybody has forgotten, so what has
 * fallen due comes first, before the register it came out of — a register is
 * something you consult, and an overdue adjustment is something that has to
 * find you.
 *
 * Every figure on this page arrives from the server as minor units in a string
 * and is formatted here. The adjustment preview is fetched rather than computed
 * in the browser: the number shown before posting has to be the number that
 * posts, and two implementations of one formula eventually disagree.
 */

interface RegisterInterval {
  interval: number;
  from: string;
  to: string;
  state: "original" | "assessed" | "due" | "not_yet_due";
  useBps: number | null;
  adjustmentMinor: string | null;
  assessedOn: string | null;
  entryId: string | null;
  reference: string | null;
}
interface RegisterAsset {
  code: string;
  description: string;
  category: "BUILDING" | "OTHER";
  acquiredOn: string;
  firstUsedOn: string;
  adjustmentPeriodEndsOn: string;
  costMinor: string;
  inputTaxMinor: string;
  originalUseBps: number;
  status: string;
  intervals: number;
  perIntervalMinor: string;
  intervalRows: RegisterInterval[];
  assessedCount: number;
  outstandingCount: number;
  adjustedMinor: string;
}
interface Register {
  asOf: string;
  currency: string;
  assets: RegisterAsset[];
  totals: {
    inputTaxMinor: string;
    adjustedMinor: string;
    recoveredMinor: string;
    repaidMinor: string;
    outstandingCount: number;
  };
  reconciliation: { registerMinor: string; ledgerMinor: string; agrees: boolean; unpostedCount: number };
}
interface DueInterval { interval: number; from: string; to: string; dueOn: string; overdueDays: number }
interface DueAsset {
  code: string;
  description: string;
  category: "BUILDING" | "OTHER";
  firstUsedOn: string;
  intervals: number;
  inputTaxMinor: string;
  originalUseBps: number;
  perIntervalMinor: string;
  due: DueInterval[];
  boundMinor: string;
}
interface Due {
  asOf: string;
  currency: string;
  assets: DueAsset[];
  intervalCount: number;
  boundMinor: string;
  finding: { key: string; severity: "urgent" | "soon" | "note"; title: string; detail: string; count: number } | null;
}
interface Zone {
  kind: "GOODS" | "SERVICES";
  movement: "WITHIN_ZONE" | "BETWEEN_ZONES" | "INTO_ZONE" | "OUT_OF_ZONE";
  treatment: "OUT_OF_SCOPE" | "STANDARD_RATED" | "IMPORT";
  taxProfileCode: string;
  citation: string;
  reason: string;
  conditions: string[];
}
interface Payload { register: Register; due: Due; zones: Zone[] }

interface Preview {
  code: string;
  interval: number;
  from: string;
  to: string;
  useBps: number;
  originalUseBps: number;
  changeBps: number;
  perIntervalMinor: string;
  adjustmentMinor: string;
  alreadyAssessed: boolean;
}
interface Margin {
  purchaseMinor: string;
  saleMinor: string;
  marginMinor: string;
  taxMinor: string;
  netMarginMinor: string;
  ratePercent: number;
  refusal: string | null;
  notes: string[];
}

const MOVEMENT_LABEL: Record<Zone["movement"], string> = {
  WITHIN_ZONE: "Within one zone",
  BETWEEN_ZONES: "Zone to zone",
  INTO_ZONE: "Mainland into a zone",
  OUT_OF_ZONE: "Zone out to the mainland",
};
const TREATMENT_LABEL: Record<Zone["treatment"], string> = {
  OUT_OF_SCOPE: "Outside the scope",
  STANDARD_RATED: "Standard rated",
  IMPORT: "Import into the State",
};
const STATE_LABEL: Record<RegisterInterval["state"], string> = {
  original: "claimed at the outset",
  assessed: "assessed",
  due: "outstanding",
  not_yet_due: "not yet due",
};
const STATE_TONE: Record<RegisterInterval["state"], string> = {
  original: "",
  assessed: "sw-chip-ok",
  due: "sw-chip-bad",
  not_yet_due: "",
};

const pct = (bps: number) => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`;
const todayIso = () => new Date().toISOString().slice(0, 10);

export default function VatSchemesPage() {
  const entityId = useEntityId();
  const [asOf, setAsOf] = React.useState(todayIso);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [notices, setNotices] = React.useState<string[]>([]);
  const [adding, setAdding] = React.useState(false);

  const { data, error, loading, reload } = useLedgerQuery<Payload>(
    entityId ? `/api/ledger/vat-schemes?entityId=${entityId}&asOf=${asOf}` : null,
    [asOf],
  );

  // The assessment the user is working on. Held here rather than inside the
  // calculator so a row in the overdue list can hand it its own asset and
  // interval — which is the whole point of the list being on the same screen.
  const [assess, setAssess] = React.useState({ code: "", interval: "2", usePct: "", on: todayIso() });

  const call = async <T,>(label: string, body: Record<string, unknown>): Promise<T | null> => {
    setBusy(label); setErr(null); setMsg(null); setNotices([]);
    try {
      const r = await api<T>("/api/ledger/vat-schemes", {
        method: "POST",
        body: JSON.stringify({ entityId, ...body }),
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

  if (!entityId) return <Loading label="Choosing an entity…" />;

  const reg = data?.register;
  const currency = reg?.currency ?? "AED";

  return (
    <>
      <PageHead
        title="VAT schemes"
        sub={
          "The capital assets scheme, the profit margin scheme and designated zones — the three treatments the VAT " +
          "201 cannot express on its own. Adjustments posted here reach the return through the ledger, on account " +
          "1350, so the return and the books still cannot disagree."
        }
        actions={
          <>
            <label className="flex items-center gap-2">
              <span className="sw-label">As at</span>
              <input
                type="date"
                className="sw-input"
                style={{ width: "10rem" }}
                value={asOf}
                onChange={(e) => e.target.value && setAsOf(e.target.value)}
                data-testid="vs-asof"
              />
            </label>
            <button type="button" className="sw-btn" onClick={() => setAdding((a) => !a)} aria-expanded={adding}>
              {adding ? "Cancel" : "Register a capital asset"}
            </button>
          </>
        }
      />

      {err && <ErrorNote>{err}</ErrorNote>}
      {msg && <div className="sw-note mb-3" role="status" data-testid="vs-status">{msg}</div>}
      {notices.map((n, i) => (
        <div key={`n${i}`} className="sw-error mb-3" role="alert" data-testid="vs-notice">{n}</div>
      ))}
      {error && <ErrorNote>{error}</ErrorNote>}
      {loading && !data && <Loading />}

      {adding && (
        <RegisterAssetForm
          busy={busy === "register"}
          currency={currency}
          onAdd={async (asset) => {
            const r = await call<{ code: string; intervals: number; adjustmentPeriodEndsOn: string; notes: string[] }>(
              "register",
              { action: "register", ...asset },
            );
            if (!r) return;
            setAdding(false);
            setMsg(
              `${r.code} is on the register with ${r.intervals} intervals, the last of them closing ` +
                `${r.adjustmentPeriodEndsOn}.`,
            );
            setNotices(r.notes);
          }}
        />
      )}

      {data && (
        <>
          <DuePanel
            due={data.due}
            currency={currency}
            onAssess={(code, interval) => {
              setAssess((a) => ({ ...a, code, interval: String(interval), usePct: "" }));
              document.getElementById("assess-use")?.focus();
            }}
          />

          <AssessPanel
            entityId={entityId}
            assets={data.register.assets}
            value={assess}
            onChange={setAssess}
            currency={currency}
            busy={busy === "assess"}
            onPost={async () => {
              const pctValue = Number(assess.usePct);
              const r = await call<{
                code: string; interval: number; adjustmentMinor: string; reference: string | null;
                alreadyAssessed: boolean; warnings: string[];
              }>("assess", {
                action: "assess",
                code: assess.code,
                interval: Number(assess.interval),
                useBps: Math.round(pctValue * 100),
                on: assess.on,
              });
              if (!r) return;
              setMsg(
                r.alreadyAssessed
                  ? `Interval ${r.interval} of ${r.code} had already been assessed. Nothing has been posted.`
                  : r.reference
                    ? `Interval ${r.interval} of ${r.code} assessed: ${r.adjustmentMinor.startsWith("-") ? "repayable" : "recoverable"} adjustment posted as ${r.reference}.`
                    : `Interval ${r.interval} of ${r.code} assessed at ${pct(Math.round(pctValue * 100))}. There was no change, so nothing was posted.`,
              );
              setNotices(r.warnings);
            }}
          />

          <RegisterPanel
            register={data.register}
            currency={currency}
            busy={busy}
            onDispose={async (code, on) => {
              const r = await call<{ code: string; remainingIntervals: number[]; adjustmentMinor: string; reference: string | null; warnings: string[] }>(
                "dispose",
                { action: "dispose", code, on },
              );
              if (!r) return;
              setMsg(
                `${r.code} disposed of. The final adjustment covered ` +
                  `${r.remainingIntervals.length === 1 ? "interval" : "intervals"} ${r.remainingIntervals.join(", ")}` +
                  (r.reference ? `, posted as ${r.reference}.` : ", and came to nothing."),
              );
              setNotices(r.warnings);
            }}
          />

          <MarginPanel entityId={entityId} currency={currency} />

          <ZonePanel zones={data.zones} />
        </>
      )}
    </>
  );
}

/* ─────────────────────────────────────────────────────────── what has fallen due */

function DuePanel({ due, currency, onAssess }: {
  due: Due;
  currency: string;
  onAssess: (code: string, interval: number) => void;
}) {
  if (due.intervalCount === 0) {
    return (
      <Panel className="mb-4 p-4">
        <div className="sw-label">Adjustments due</div>
        <p className="sw-sub mt-1.5 max-w-[74ch]">
          Nothing has fallen due as at {due.asOf}. An interval can only be assessed once its twelve months are over,
          because the proportion of taxable use is measured across the whole year.
        </p>
      </Panel>
    );
  }

  return (
    <Panel className="mb-4 overflow-hidden">
      <div
        className="flex flex-wrap items-baseline justify-between gap-2 border-b px-3 py-2"
        style={{ borderColor: "var(--sw-line)", background: "var(--sw-surface-2)" }}
      >
        <span className="sw-label">{due.finding?.title ?? "Adjustments due"}</span>
        <span className="sw-chip sw-chip-bad">{due.intervalCount} outstanding</span>
      </div>
      <p className="sw-sub px-3 pt-2 max-w-[80ch]" role="status" data-testid="vs-due-detail">
        {due.finding?.detail}
      </p>
      <div className="sw-scroll">
        <table className="sw-table">
          <caption className="sr-only">Capital asset intervals that have closed without an adjustment</caption>
          <thead>
            <tr>
              <th style={{ width: "6rem" }}>Asset</th>
              <th>Description</th>
              <th className="sw-num" style={{ width: "4.5rem" }}>Interval</th>
              <th style={{ width: "7rem" }}>Year ended</th>
              <th className="sw-num hidden md:table-cell" style={{ width: "6rem" }}>Days</th>
              <th className="sw-num hidden lg:table-cell" style={{ width: "var(--sw-col-amount)" }}>At most</th>
              <th style={{ width: "6rem" }} />
            </tr>
          </thead>
          <tbody>
            {due.assets.flatMap((a) =>
              a.due.map((d) => (
                <tr key={`${a.code}-${d.interval}`} data-testid={`vs-due-${a.code}-${d.interval}`}>
                  <td className="sw-code">{a.code}</td>
                  <td className="max-w-0 truncate">
                    {a.description}
                    <span className="sw-sub"> · claimed at {pct(a.originalUseBps)}</span>
                  </td>
                  <td className="sw-num">{d.interval} of {a.intervals}</td>
                  <td>{d.to}</td>
                  <td className="sw-num hidden md:table-cell">{d.overdueDays}</td>
                  <td className="sw-num hidden lg:table-cell">
                    <Figure minor={a.perIntervalMinor} currency={currency} colour={false} />
                  </td>
                  <td>
                    <button
                      type="button"
                      className="sw-btn sw-btn-sm"
                      onClick={() => onAssess(a.code, d.interval)}
                      data-testid={`vs-assess-${a.code}-${d.interval}`}
                    >
                      Assess
                    </button>
                  </td>
                </tr>
              )),
            )}
          </tbody>
          <tfoot>
            {/* Each column keeps its own cell, carrying the same responsive
                class as its header. A colSpan across a column that is display:
                none at this width would shift the total out from under it. */}
            <tr>
              <th scope="row" colSpan={4} style={{ textAlign: "start" }}>
                Most that could turn on these, either way
              </th>
              <td className="hidden md:table-cell" />
              <td className="sw-num hidden lg:table-cell" data-testid="vs-due-bound">
                <Figure minor={due.boundMinor} currency={currency} colour={false} />
              </td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="sw-sub px-3 py-2" style={{ borderTop: "1px solid var(--sw-line)" }}>
        The exact adjustment is not shown because it is not known here: it needs the proportion of taxable use over
        each year, and no accounting record holds that. The column above is the most one interval could move in
        either direction.
      </p>
    </Panel>
  );
}

/* ──────────────────────────────────────────────────────── the adjustment calculator */

function AssessPanel({ entityId, assets, value, onChange, currency, busy, onPost }: {
  entityId: string;
  assets: RegisterAsset[];
  value: { code: string; interval: string; usePct: string; on: string };
  onChange: (v: { code: string; interval: string; usePct: string; on: string }) => void;
  currency: string;
  busy: boolean;
  onPost: () => void;
}) {
  const set = (patch: Partial<typeof value>) => onChange({ ...value, ...patch });
  const asset = assets.find((a) => a.code === value.code);
  const interval = Number(value.interval);
  const usePctNumber = Number(value.usePct);
  const useBps = Math.round(usePctNumber * 100);

  const ready =
    Boolean(asset) &&
    Number.isInteger(interval) &&
    interval >= 2 &&
    asset !== undefined &&
    interval <= asset.intervals &&
    value.usePct.trim() !== "" &&
    Number.isFinite(usePctNumber) &&
    useBps >= 0 &&
    useBps <= 10_000;

  const { data: preview, error: previewError } = useLedgerQuery<{ preview: Preview }>(
    ready
      ? `/api/ledger/vat-schemes?entityId=${entityId}&view=adjustment&code=${encodeURIComponent(value.code)}&interval=${interval}&useBps=${useBps}`
      : null,
    [value.code, interval, useBps],
  );

  const row = asset?.intervalRows.find((r) => r.interval === interval);
  const blocker =
    !asset ? "Choose the capital asset." :
    !Number.isInteger(interval) || interval < 2 ? "Interval 1 is the year of first use — adjustments start at interval 2." :
    interval > asset.intervals ? `${asset.code} has ${asset.intervals} intervals.` :
    value.usePct.trim() === "" ? "What proportion of the year's use was taxable?" :
    !Number.isFinite(usePctNumber) || useBps < 0 || useBps > 10_000 ? "Taxable use is a percentage between 0 and 100." :
    row?.state === "assessed" ? `Interval ${interval} was already assessed on ${row.assessedOn}. A posted entry is corrected by reversal.` :
    row?.state === "not_yet_due" ? `Interval ${interval} runs to ${row.to}; there is nothing to assess until the year is over.` :
    null;

  return (
    <Panel className="mb-4 p-4">
      <div className="sw-label">Assess an interval</div>
      <p className="sw-sub mt-1 max-w-[80ch]">
        A tenth of the input tax for a building, a fifth for anything else, multiplied by the change between this
        year&rsquo;s taxable use and the proportion claimed at the outset (Executive Regulation Article 58). The
        proportion is a measurement you make; nothing in these books contains it.
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Capital asset">
          <select
            className="sw-select"
            value={value.code}
            onChange={(e) => set({ code: e.target.value })}
            data-testid="assess-code"
          >
            <option value="">Choose…</option>
            {assets.filter((a) => a.status === "active").map((a) => (
              <option key={a.code} value={a.code}>{a.code} — {a.description}</option>
            ))}
          </select>
        </Field>
        <Field label="Interval">
          <input
            className="sw-input sw-cell-num"
            inputMode="numeric"
            value={value.interval}
            onChange={(e) => set({ interval: e.target.value })}
            data-testid="assess-interval"
          />
        </Field>
        <Field label="Taxable use this interval (%)">
          <input
            id="assess-use"
            className="sw-input sw-cell-num"
            inputMode="decimal"
            value={value.usePct}
            onChange={(e) => set({ usePct: e.target.value })}
            placeholder="70"
            data-testid="assess-use"
          />
        </Field>
        <Field label="Post on">
          <input
            type="date"
            className="sw-input"
            value={value.on}
            onChange={(e) => e.target.value && set({ on: e.target.value })}
            data-testid="assess-on"
          />
        </Field>
      </div>

      {asset && (
        <table className="sw-table mt-3" style={{ maxWidth: "40rem" }}>
          <caption className="sr-only">The adjustment this would post</caption>
          <tbody>
            <tr>
              <th scope="row" style={{ textAlign: "start", fontWeight: 400 }}>
                Input tax on {asset.code}, over {asset.intervals} intervals
              </th>
              <td className="sw-num"><Figure minor={asset.inputTaxMinor} currency={currency} colour={false} /></td>
            </tr>
            <tr>
              <th scope="row" style={{ textAlign: "start", fontWeight: 400 }}>One interval&rsquo;s share</th>
              <td className="sw-num"><Figure minor={asset.perIntervalMinor} currency={currency} colour={false} /></td>
            </tr>
            <tr>
              <th scope="row" style={{ textAlign: "start", fontWeight: 400 }}>
                Change in taxable use against {pct(asset.originalUseBps)} claimed at the outset
              </th>
              <td className="sw-num">
                {preview ? `${preview.preview.changeBps > 0 ? "+" : ""}${pct(preview.preview.changeBps)}` : "–"}
              </td>
            </tr>
            <tr>
              <th scope="row" style={{ textAlign: "start" }}>
                Adjustment {preview && BigInt(preview.preview.adjustmentMinor) < 0n ? "— repayable to the FTA" : "— further input tax recoverable"}
              </th>
              <td className="sw-num" data-testid="assess-preview">
                {preview ? <Figure minor={preview.preview.adjustmentMinor} currency={currency} zero="zero" /> : "–"}
              </td>
            </tr>
          </tbody>
        </table>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="sw-btn sw-btn-primary"
          aria-disabled={blocker !== null || busy || undefined}
          disabled={blocker !== null || busy}
          onClick={onPost}
          data-testid="assess-post"
        >
          {busy ? "Posting…" : "Post the adjustment"}
        </button>
        {blocker && <span className="sw-sub" role="status" data-testid="assess-blocker">{blocker}</span>}
        {previewError && <span className="sw-sub" role="alert">{previewError}</span>}
      </div>
    </Panel>
  );
}

/* ─────────────────────────────────────────────────────────────────── the register */

function RegisterPanel({ register, currency, busy, onDispose }: {
  register: Register;
  currency: string;
  busy: string | null;
  onDispose: (code: string, on: string) => void;
}) {
  const [open, setOpen] = React.useState<Record<string, boolean>>({});
  const [disposing, setDisposing] = React.useState<string | null>(null);
  const [disposeOn, setDisposeOn] = React.useState(todayIso());

  const isOpen = (a: RegisterAsset) => open[a.code] ?? a.outstandingCount > 0;

  return (
    <Panel className="mb-4 overflow-hidden">
      <div className="border-b px-3 py-2" style={{ borderColor: "var(--sw-line)", background: "var(--sw-surface-2)" }}>
        <span className="sw-label">Capital asset register — as at {register.asOf}</span>
      </div>

      {register.assets.length === 0 ? (
        <div className="p-3">
          <Empty>
            Nothing on the register. An item of expenditure of AED 5,000,000 or more excluding tax, with a useful
            life of ten years for a building or five for anything else, belongs here (Executive Regulation Article 57).
          </Empty>
        </div>
      ) : (
        <div className="sw-scroll">
          <table className="sw-table">
            <caption className="sr-only">Capital assets and the state of each interval</caption>
            <thead>
              <tr>
                <th style={{ width: "2rem" }} />
                <th style={{ width: "6rem" }}>Code</th>
                <th>Asset</th>
                <th className="hidden md:table-cell" style={{ width: "7rem" }}>First used</th>
                <th className="sw-num hidden lg:table-cell" style={{ width: "var(--sw-col-amount)" }}>Cost</th>
                <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Input tax</th>
                <th className="sw-num hidden md:table-cell" style={{ width: "5rem" }}>Claimed</th>
                <th className="sw-num" style={{ width: "6rem" }}>Intervals</th>
                <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Adjusted</th>
                <th style={{ width: "8rem" }}>Status</th>
              </tr>
            </thead>
            {register.assets.map((a) => (
              <tbody key={a.code}>
                <tr data-testid={`vs-asset-${a.code}`}>
                  <td>
                    <button
                      type="button"
                      className="sw-icon-btn"
                      aria-expanded={isOpen(a)}
                      aria-controls={`intervals-${a.code}`}
                      aria-label={`${isOpen(a) ? "Hide" : "Show"} the intervals of ${a.code}`}
                      onClick={() => setOpen((o) => ({ ...o, [a.code]: !isOpen(a) }))}
                    >
                      {isOpen(a) ? "−" : "+"}
                    </button>
                  </td>
                  <td className="sw-code">{a.code}</td>
                  <td className="max-w-0 truncate">
                    {a.description}
                    <span className="sw-sub"> · {a.category === "BUILDING" ? "building" : "other"}</span>
                  </td>
                  <td className="hidden md:table-cell">{a.firstUsedOn}</td>
                  <td className="sw-num hidden lg:table-cell"><Figure minor={a.costMinor} currency={currency} colour={false} /></td>
                  <td className="sw-num"><Figure minor={a.inputTaxMinor} currency={currency} colour={false} /></td>
                  <td className="sw-num hidden md:table-cell">{pct(a.originalUseBps)}</td>
                  <td className="sw-num">
                    {a.assessedCount} / {a.intervals}
                    {a.outstandingCount > 0 && (
                      <span className="sw-chip sw-chip-bad" style={{ marginInlineStart: "0.375rem" }}>
                        {a.outstandingCount} due
                      </span>
                    )}
                  </td>
                  <td className="sw-num" data-testid={`vs-adjusted-${a.code}`}>
                    <Figure minor={a.adjustedMinor} currency={currency} zero="zero" />
                  </td>
                  <td>
                    <StatusChip status={a.status} />{" "}
                    {a.status === "active" && (
                      <button
                        type="button"
                        className="sw-btn sw-btn-sm"
                        onClick={() => setDisposing(disposing === a.code ? null : a.code)}
                        aria-expanded={disposing === a.code}
                      >
                        Dispose
                      </button>
                    )}
                  </td>
                </tr>

                {disposing === a.code && (
                  <tr>
                    <td colSpan={10} style={{ background: "var(--sw-surface-2)" }}>
                      <div className="flex flex-wrap items-end gap-3 py-1">
                        <Field label="Disposed on">
                          <input
                            type="date"
                            className="sw-input"
                            value={disposeOn}
                            onChange={(e) => e.target.value && setDisposeOn(e.target.value)}
                            data-testid={`vs-dispose-on-${a.code}`}
                          />
                        </Field>
                        <button
                          type="button"
                          className="sw-btn sw-btn-primary"
                          disabled={busy === "dispose"}
                          aria-disabled={busy === "dispose" || undefined}
                          onClick={() => { setDisposing(null); onDispose(a.code, disposeOn); }}
                          data-testid={`vs-dispose-${a.code}`}
                        >
                          {busy === "dispose" ? "Posting…" : "Post the final adjustment"}
                        </button>
                        <span className="sw-sub max-w-[52ch]">
                          Every interval left is adjusted in one, as if the asset had been used wholly for taxable
                          purposes for the remainder (Executive Regulation Article 58(12)). That deeming holds where
                          the sale itself is taxable — an exempt sale is the opposite, and is not what this posts.
                        </span>
                      </div>
                    </td>
                  </tr>
                )}

                {isOpen(a) && (
                  <tr id={`intervals-${a.code}`}>
                    <td colSpan={10} style={{ padding: 0 }}>
                      <table className="sw-table" style={{ margin: 0 }}>
                        <caption className="sr-only">Intervals of {a.code}</caption>
                        <thead>
                          <tr>
                            <th style={{ width: "2rem" }} />
                            <th className="sw-num" style={{ width: "5rem" }}>Interval</th>
                            <th style={{ width: "8rem" }}>From</th>
                            <th style={{ width: "8rem" }}>To</th>
                            <th style={{ width: "10rem" }}>State</th>
                            <th className="sw-num" style={{ width: "6rem" }}>Taxable use</th>
                            <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Adjustment</th>
                            <th style={{ width: "9rem" }}>Entry</th>
                          </tr>
                        </thead>
                        <tbody>
                          {a.intervalRows.map((r) => (
                            <tr key={r.interval} data-testid={`vs-interval-${a.code}-${r.interval}`}>
                              <td />
                              <td className="sw-num">{r.interval}</td>
                              <td>{r.from}</td>
                              <td>{r.to}</td>
                              <td><span className={`sw-chip ${STATE_TONE[r.state]}`}>{STATE_LABEL[r.state]}</span></td>
                              <td className="sw-num">{r.useBps === null ? <span className="sw-zero">–</span> : pct(r.useBps)}</td>
                              <td className="sw-num">
                                {r.adjustmentMinor === null
                                  ? <span className="sw-zero">–</span>
                                  : <Figure minor={r.adjustmentMinor} currency={currency} zero="zero" />}
                              </td>
                              <td>
                                {r.reference
                                  ? <Link href="/accounting/journals" className="sw-link">{r.reference}</Link>
                                  : <span className="sw-zero">–</span>}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </td>
                  </tr>
                )}
              </tbody>
            ))}
            <tfoot>
              <tr>
                <td />
                <th scope="row" colSpan={2} style={{ textAlign: "start" }}>
                  Input tax on the register, and what has been adjusted since
                </th>
                <td className="hidden md:table-cell" />
                <td className="hidden lg:table-cell" />
                <td className="sw-num" data-testid="vs-total-inputtax">
                  <Figure minor={register.totals.inputTaxMinor} currency={currency} zero="zero" colour={false} />
                </td>
                <td className="hidden md:table-cell" />
                <td className="sw-num">{register.totals.outstandingCount || "–"}</td>
                <td className="sw-num" data-testid="vs-total-adjusted">
                  <Figure minor={register.totals.adjustedMinor} currency={currency} zero="zero" />
                </td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      <div className="px-3 py-3" style={{ borderTop: "1px solid var(--sw-line)" }}>
        <div className="sw-label">Register against the ledger</div>
        <table className="sw-table mt-2" style={{ maxWidth: "40rem" }}>
          <caption className="sr-only">Adjustments recorded against the movement they made on account 1350</caption>
          <thead>
            <tr>
              <th />
              <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Register</th>
              <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Ledger</th>
              <th style={{ width: "9rem" }} />
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row" style={{ textAlign: "start", fontWeight: 400 }}>Adjustments posted</th>
              <td className="sw-num" data-testid="vs-recon-register">
                <Figure minor={register.reconciliation.registerMinor} currency={currency} zero="zero" colour={false} />
              </td>
              <td className="sw-num" data-testid="vs-recon-ledger">
                <Figure minor={register.reconciliation.ledgerMinor} currency={currency} zero="zero" colour={false} />
              </td>
              <td>
                <Link href="/accounting/accounts/1350" className="sw-link">1350</Link>{" "}
                <span className={`sw-chip ${register.reconciliation.agrees ? "sw-chip-ok" : "sw-chip-bad"}`}>
                  {register.reconciliation.agrees ? "agrees" : "differs"}
                </span>
              </td>
            </tr>
          </tbody>
        </table>
        {!register.reconciliation.agrees && (
          <p className="sw-sub mt-2" style={{ color: "var(--sw-neg)" }} role="alert">
            The register and account 1350 disagree. That is a finding, not a display problem — an adjustment was
            recorded without reaching the books, or an entry was reversed without the register being told.
          </p>
        )}
        {register.reconciliation.unpostedCount > 0 && (
          <p className="sw-sub mt-2" role="alert">
            {register.reconciliation.unpostedCount} assessment
            {register.reconciliation.unpostedCount === 1 ? " has" : "s have"} no journal entry behind
            {register.reconciliation.unpostedCount === 1 ? " it" : " them"}.
          </p>
        )}
      </div>
    </Panel>
  );
}

/* ────────────────────────────────────────────────────── the margin scheme calculator */

function MarginPanel({ entityId, currency }: { entityId: string; currency: string }) {
  const [purchase, setPurchase] = React.useState("");
  const [sale, setSale] = React.useState("");
  const [asked, setAsked] = React.useState<{ purchase: string; sale: string } | null>(null);

  const purchaseMinor = parseAmount(purchase);
  const saleMinor = parseAmount(sale);
  const blocker =
    purchase.trim() === "" || sale.trim() === "" ? "Enter what the goods cost and what they sold for." :
    purchaseMinor === null || saleMinor === null ? "That is not an amount." :
    purchaseMinor < 0n || saleMinor < 0n ? "A price cannot be negative." :
    null;

  const { data, error } = useLedgerQuery<{ margin: Margin }>(
    asked
      ? `/api/ledger/vat-schemes?entityId=${entityId}&view=margin&purchaseMinor=${asked.purchase}&saleMinor=${asked.sale}`
      : null,
    [asked?.purchase ?? "", asked?.sale ?? ""],
  );
  const m = data?.margin;

  return (
    <Panel className="mb-4 p-4">
      <div className="sw-label">Profit margin scheme</div>
      <p className="sw-sub mt-1 max-w-[80ch]">
        On qualifying second-hand goods the tax is due on the margin rather than on the whole selling price
        (Article 29 of Federal Decree-Law 8/2017, Article 43 of the Executive Regulation). The tax is treated as
        included in that margin, so it is 5/105 of it — not 5% of it.
      </p>
      <form
        className="mt-3 flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (blocker) return;
          setAsked({ purchase: purchaseMinor!.toString(), sale: saleMinor!.toString() });
        }}
      >
        <Field label="Purchase price">
          <input
            className="sw-input sw-cell-num"
            inputMode="decimal"
            value={purchase}
            onChange={(e) => setPurchase(e.target.value)}
            placeholder="30,000.00"
            data-testid="margin-purchase"
          />
        </Field>
        <Field label="Selling price">
          <input
            className="sw-input sw-cell-num"
            inputMode="decimal"
            value={sale}
            onChange={(e) => setSale(e.target.value)}
            placeholder="35,000.00"
            data-testid="margin-sale"
          />
        </Field>
        <button
          type="submit"
          className="sw-btn sw-btn-primary"
          aria-disabled={blocker !== null || undefined}
          disabled={blocker !== null}
          data-testid="margin-go"
        >
          Work out the tax
        </button>
        {blocker && <span className="sw-sub" role="status">{blocker}</span>}
      </form>

      {error && <ErrorNote>{error}</ErrorNote>}

      {m && (
        <>
          <table className="sw-table mt-3" style={{ maxWidth: "34rem" }}>
            <caption className="sr-only">Tax on the profit margin</caption>
            <tbody>
              <tr>
                <th scope="row" style={{ textAlign: "start", fontWeight: 400 }}>Selling price</th>
                <td className="sw-num"><Figure minor={m.saleMinor} currency={currency} zero="zero" colour={false} /></td>
              </tr>
              <tr>
                <th scope="row" style={{ textAlign: "start", fontWeight: 400 }}>Less what they cost</th>
                <td className="sw-num"><Figure minor={m.purchaseMinor} currency={currency} zero="zero" colour={false} /></td>
              </tr>
              <tr>
                <th scope="row" style={{ textAlign: "start" }}>Margin</th>
                <td className="sw-num" data-testid="margin-margin">
                  <Figure minor={m.marginMinor} currency={currency} zero="zero" colour={false} />
                </td>
              </tr>
              <tr>
                <th scope="row" style={{ textAlign: "start", fontWeight: 400 }}>Value of the supply</th>
                <td className="sw-num"><Figure minor={m.netMarginMinor} currency={currency} zero="zero" colour={false} /></td>
              </tr>
              <tr>
                <th scope="row" style={{ textAlign: "start" }}>
                  Tax due, {m.ratePercent}/{100 + m.ratePercent} of the margin
                </th>
                <td className="sw-num" data-testid="margin-tax">
                  <Figure minor={m.taxMinor} currency={currency} zero="zero" colour={false} />
                </td>
              </tr>
            </tbody>
          </table>
          {m.refusal && (
            <div className="sw-error mt-3" role="alert" data-testid="margin-refusal">{m.refusal}</div>
          )}
          <ul className="mt-3 space-y-1">
            {m.notes.map((n, i) => (
              <li key={i} className="sw-sub max-w-[80ch]">{n}</li>
            ))}
          </ul>
        </>
      )}
    </Panel>
  );
}

/* ──────────────────────────────────────────────────────────────── designated zones */

function ZonePanel({ zones }: { zones: Zone[] }) {
  return (
    <Panel className="mb-4 overflow-hidden">
      <div className="border-b px-3 py-2" style={{ borderColor: "var(--sw-line)", background: "var(--sw-surface-2)" }}>
        <span className="sw-label">Designated zones</span>
      </div>
      <p className="sw-sub px-3 pt-2 max-w-[80ch]">
        A designated zone is treated as outside the State for goods and inside it for services (Article 51 of Federal
        Decree-Law 8/2017 with Article 51 of the Executive Regulation). That asymmetry is where the money goes: the
        same company, the same customer, one invoice outside the scope and the next standard rated.
      </p>
      <div className="sw-scroll">
        <table className="sw-table">
          <caption className="sr-only">How a supply touching a designated zone is treated</caption>
          <thead>
            <tr>
              <th style={{ width: "6rem" }}>Supply</th>
              <th style={{ width: "12rem" }}>Movement</th>
              <th style={{ width: "11rem" }}>Treatment</th>
              <th style={{ width: "9rem" }}>Tax code</th>
              <th>Why</th>
            </tr>
          </thead>
          <tbody>
            {zones.map((z) => (
              <tr key={`${z.kind}-${z.movement}`} data-testid={`vs-zone-${z.kind}-${z.movement}`}>
                <td>{z.kind === "GOODS" ? "Goods" : "Services"}</td>
                <td>{MOVEMENT_LABEL[z.movement]}</td>
                <td>
                  <span className={`sw-chip ${z.treatment === "OUT_OF_SCOPE" ? "sw-chip-accent" : "sw-chip-warn"}`}>
                    {TREATMENT_LABEL[z.treatment]}
                  </span>
                </td>
                <td className="sw-code">{z.taxProfileCode}</td>
                <td className="sw-sub">
                  {z.reason}
                  <span className="block" style={{ color: "var(--sw-fg-faint)" }}>{z.citation}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="space-y-1 px-3 py-2" style={{ borderTop: "1px solid var(--sw-line)" }}>
        {[...new Set(zones.flatMap((z) => z.conditions))].map((c, i) => (
          <li key={i} className="sw-sub max-w-[80ch]">{c}</li>
        ))}
      </ul>
    </Panel>
  );
}

/* ───────────────────────────────────────────────────────────── registering an asset */

function RegisterAssetForm({ busy, currency, onAdd }: {
  busy: boolean;
  currency: string;
  onAdd: (a: {
    code: string; description: string; category: "BUILDING" | "OTHER";
    acquiredOn: string; firstUsedOn: string; costMinor: string; inputTaxMinor: string; originalUseBps: number;
  }) => void;
}) {
  const [f, setF] = React.useState({
    code: "",
    description: "",
    category: "OTHER" as "BUILDING" | "OTHER",
    acquiredOn: todayIso(),
    firstUsedOn: todayIso(),
    cost: "",
    inputTax: "",
    usePct: "100",
  });
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));

  const cost = parseAmount(f.cost);
  const inputTax = parseAmount(f.inputTax);
  const useBps = Math.round(Number(f.usePct) * 100);
  // The threshold is checked on the server, which owns the rule; repeating it
  // here would be a second copy of the law. What the form does is stop a
  // request that cannot succeed for reasons the form can see for itself.
  const blocker =
    !f.code.trim() ? "Give the asset a code." :
    !f.description.trim() ? "Describe it — the person adjusting it in eight years has never seen it." :
    cost === null || cost <= 0n ? "What did it cost, excluding tax?" :
    inputTax === null || inputTax < 0n ? "How much input tax was charged on it?" :
    f.firstUsedOn < f.acquiredOn ? "It cannot have been used before it was bought." :
    !Number.isFinite(useBps) || useBps < 0 || useBps > 10_000 ? "Taxable use is a percentage between 0 and 100." :
    null;

  return (
    <Panel className="mb-4 p-4">
      <div className="sw-label">Register a capital asset</div>
      <p className="sw-sub mt-1 max-w-[80ch]">
        Whether this is one capital asset, and whether it will last ten years or five, are judgements. They are taken
        from you and recorded as such — nothing in the ledger can settle either. The adjustment period runs from the
        day the asset was first used, not from the purchase.
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Code">
          <input className="sw-input" value={f.code} onChange={(e) => set("code", e.target.value)} placeholder="CA-001" data-testid="ca-code" />
        </Field>
        <Field label="Description">
          <input className="sw-input" value={f.description} onChange={(e) => set("description", e.target.value)} placeholder="Warehouse, Jebel Ali" data-testid="ca-description" />
        </Field>
        <Field label="Category">
          <select
            className="sw-select"
            value={f.category}
            onChange={(e) => set("category", e.target.value)}
            data-testid="ca-category"
          >
            <option value="BUILDING">Building or part of one — ten intervals</option>
            <option value="OTHER">Anything else — five intervals</option>
          </select>
        </Field>
        <Field label="Taxable use claimed (%)">
          <input className="sw-input sw-cell-num" inputMode="decimal" value={f.usePct} onChange={(e) => set("usePct", e.target.value)} data-testid="ca-use" />
        </Field>
        <Field label="Acquired">
          <input type="date" className="sw-input" value={f.acquiredOn} onChange={(e) => e.target.value && set("acquiredOn", e.target.value)} data-testid="ca-acquired" />
        </Field>
        <Field label="First used">
          <input type="date" className="sw-input" value={f.firstUsedOn} onChange={(e) => e.target.value && set("firstUsedOn", e.target.value)} data-testid="ca-firstused" />
        </Field>
        <Field label={`Cost excluding tax (${currency})`}>
          <input className="sw-input sw-cell-num" inputMode="decimal" value={f.cost} onChange={(e) => set("cost", e.target.value)} placeholder="6,000,000.00" data-testid="ca-cost" />
        </Field>
        <Field label={`Input tax charged (${currency})`}>
          <input className="sw-input sw-cell-num" inputMode="decimal" value={f.inputTax} onChange={(e) => set("inputTax", e.target.value)} placeholder="300,000.00" data-testid="ca-inputtax" />
        </Field>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="sw-btn sw-btn-primary"
          aria-disabled={blocker !== null || busy || undefined}
          disabled={blocker !== null || busy}
          data-testid="ca-save"
          onClick={() =>
            onAdd({
              code: f.code.trim(),
              description: f.description.trim(),
              category: f.category,
              acquiredOn: f.acquiredOn,
              firstUsedOn: f.firstUsedOn,
              costMinor: (cost as bigint).toString(),
              inputTaxMinor: (inputTax as bigint).toString(),
              originalUseBps: useBps,
            })
          }
        >
          {busy ? "Saving…" : "Put it on the register"}
        </button>
        {blocker && <span className="sw-sub" role="status" data-testid="ca-blocker">{blocker}</span>}
        {!blocker && cost !== null && inputTax !== null && (
          <span className="sw-sub">
            {f.category === "BUILDING" ? "Ten" : "Five"} intervals of about{" "}
            {toInput(inputTax / BigInt(f.category === "BUILDING" ? 10 : 5), currency)} each.
          </span>
        )}
      </div>
    </Panel>
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
