"use client";

import * as React from "react";
import { useEntityId, useLedgerQuery, api, ApiError } from "@/components/ledger/use-ledger";
import { PageHead, Panel, ErrorNote, Loading, Empty } from "@/components/ledger/primitives";

/* The shapes the API returns; see src/lib/server/ledger/numbering.ts. */
interface Integrity {
  verdict: "clean" | "gap" | "reuse" | "unchecked" | "empty";
  issued: number; live: number; retired: number;
  firstReference: string | null; lastReference: string | null;
  runs: { prefix: string; from: string; to: string; count: number; firstIssued: string }[];
  gaps: string[]; gapCount: number; duplicates: string[]; unreadable: string[];
  note: string;
}
interface Config { prefix: string; padding: number; restartYearly: boolean }
interface Change {
  changedAt: string; effectiveFromNo: number;
  from: Config; to: Config; note: string | null; actorId: string | null;
}
interface Series extends Config {
  scope: string; label: string; modules: string[]; configured: boolean;
  expandedPrefix: string; allocated: number; nextReference: string; restartPending: boolean;
  lastIssued: { reference: string; date: string; status: string; label: string | null } | null;
  integrity: Integrity;
  changes: Change[];
}
interface Overview {
  cycle: { start: string; year: string; next: { start: string; year: string }; fromFiscalYear: boolean };
  series: Series[];
  catalogue: { scanned: boolean; note: string };
  unattributed: string[];
}
interface Preview {
  scope: string; config: Config;
  next: string; following: string; afterRestart: string; current: string;
  restartsOn: string; changes: string[];
}

const VERDICT: Record<Integrity["verdict"], { tone: string; word: string }> = {
  clean: { tone: "sw-chip-ok", word: "unbroken" },
  gap: { tone: "sw-chip-bad", word: "gap" },
  reuse: { tone: "sw-chip-bad", word: "reused" },
  unchecked: { tone: "sw-chip-warn", word: "unchecked" },
  empty: { tone: "", word: "unused" },
};

export default function NumberingPage() {
  const entityId = useEntityId();
  const { data, error, loading, reload } = useLedgerQuery<Overview>(
    entityId ? `/api/ledger/numbering?entityId=${entityId}` : null,
  );
  const [selected, setSelected] = React.useState<string | null>(null);

  if (!entityId) return <Loading label="Choosing an entity…" />;
  const series = data?.series ?? [];
  const chosen = series.find((s) => s.scope === selected) ?? null;

  return (
    <>
      <PageHead
        title="Document numbering"
        sub="Every document this business issues takes its number from one of these series. A number is allocated inside the transaction that writes the document and the counter stays locked until that commits, so a posting that fails hands its number back instead of burning it. That is why there is nothing on this screen that sets the next number: what you can change is how a number is written, not which one comes next."
      />

      {error && <ErrorNote>{error}</ErrorNote>}
      {loading && <Loading />}

      {data && (
        <div className="grid gap-4">
          <Panel>
            <p className="sw-sub px-3 py-2" data-testid="numbering-cycle">
              Numbers issued today belong to the financial year beginning {data.cycle.start}
              {data.cycle.fromFiscalYear
                ? ", taken from this entity's own calendar."
                : ". No fiscal year covers today, so the calendar year is used until one is opened."}{" "}
              A series set to restart yearly next goes back to 1 on {data.cycle.next.start}, writing{" "}
              {data.cycle.next.year} into its numbers. {data.catalogue.note}
              {data.unattributed.length > 0 && (
                <> Documents numbered outside any series: {data.unattributed.join(", ")}.</>
              )}
            </p>
          </Panel>

          {series.length === 0 && <Empty>No series were found — the books are not open yet.</Empty>}

          {series.length > 0 && (
            <Panel className="overflow-hidden">
              <Head>Series in use</Head>
              <div className="sw-scroll">
                <table className="sw-table">
                  <caption className="sr-only">
                    Every number series this entity uses, with its format, its counter and the integrity of what it has issued
                  </caption>
                  <thead>
                    <tr>
                      <th style={{ width: "4.5rem" }}>Series</th>
                      <th style={{ minWidth: "12rem" }}>What it numbers</th>
                      <th style={{ width: "8rem" }}>Prefix</th>
                      <th className="sw-num" style={{ width: "4.5rem" }}>Width</th>
                      <th style={{ width: "6rem" }}>Restarts</th>
                      <th style={{ width: "11rem" }}>Next reference</th>
                      <th className="sw-num" style={{ width: "5rem" }}>Issued</th>
                      <th className="hidden md:table-cell" style={{ width: "13rem" }}>Last document</th>
                      <th style={{ width: "7rem" }}>Numbering</th>
                      <th style={{ width: "6rem" }}><span className="sr-only">Configure</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {series.map((s) => (
                      <tr key={s.scope} data-testid={`series-${s.scope}`}
                        style={s.scope === selected ? { background: "var(--sw-surface-2)" } : undefined}>
                        <td className="sw-code">{s.scope}</td>
                        <td>
                          {s.label}
                          {s.modules.length > 0 && (
                            <span className="sw-sub"> · {s.modules.map((m) => m.replace(/\.ts$/, "")).join(", ")}</span>
                          )}
                        </td>
                        <td className="sw-code">
                          {s.prefix || <span className="sw-zero">none</span>}
                          {s.expandedPrefix !== s.prefix && <span className="sw-sub block">now {s.expandedPrefix}</span>}
                        </td>
                        <td className="sw-num">{s.padding}</td>
                        <td>
                          {s.restartYearly
                            ? <span className="sw-chip sw-chip-accent">yearly</span>
                            : <span className="sw-sub">continuous</span>}
                          {s.restartPending && <span className="sw-sub block">the next one opens the new year</span>}
                        </td>
                        <td className="sw-code">{s.nextReference}</td>
                        <td className="sw-num">{s.integrity.issued}</td>
                        <td className="hidden md:table-cell">
                          {s.lastIssued ? (
                            <>
                              <span className="sw-code">{s.lastIssued.reference}</span>{" "}
                              <span className="sw-sub">{s.lastIssued.date}</span>
                            </>
                          ) : <span className="sw-zero">—</span>}
                        </td>
                        <td>
                          <span className={`sw-chip ${VERDICT[s.integrity.verdict].tone}`}>
                            {VERDICT[s.integrity.verdict].word}
                            {s.integrity.gapCount > 0 && ` ${s.integrity.gapCount}`}
                          </span>
                        </td>
                        <td>
                          <button type="button" className="sw-btn sw-btn-sm"
                            aria-expanded={s.scope === selected}
                            onClick={() => setSelected(s.scope === selected ? null : s.scope)}>
                            {s.scope === selected ? "Close" : "Configure"}
                            <span className="sr-only"> series {s.scope}</span>
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          )}

          {chosen && <Configure key={chosen.scope} entityId={entityId} series={chosen} onSaved={reload} />}

          <Findings series={series} />
        </div>
      )}
    </>
  );
}

/* ------------------------------------------------------------- configuring */

function Configure({ entityId, series, onSaved }: { entityId: string; series: Series; onSaved: () => void }) {
  const [form, setForm] = React.useState<Config & { note: string }>({
    prefix: series.prefix, padding: series.padding, restartYearly: series.restartYearly, note: "",
  });
  // The preview is worked out by the server, because only the server knows
  // which number is next and which financial year it falls in. Debounced so a
  // typed prefix does not fire a request per keystroke.
  const [settled, setSettled] = React.useState(form);
  React.useEffect(() => {
    const t = setTimeout(() => setSettled(form), 250);
    return () => clearTimeout(t);
  }, [form]);

  const q = useLedgerQuery<{ preview: Preview }>(
    `/api/ledger/numbering?entityId=${entityId}&view=preview&scope=${series.scope}` +
      `&prefix=${encodeURIComponent(settled.prefix)}&padding=${settled.padding}&restartYearly=${settled.restartYearly}`,
  );

  const [busy, setBusy] = React.useState(false);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setSaveError(null);
    setSaved(null);
    try {
      const r = await api<{ changed: boolean; series: Series }>("/api/ledger/numbering", {
        method: "PATCH",
        body: JSON.stringify({ entityId, scope: series.scope, ...form }),
      });
      setSaved(r.changed
        ? `Saved. From number ${r.series.changes[0]?.effectiveFromNo ?? "—"} on, ${series.scope} is written the new way.`
        : "Nothing to change — that is what the series already does.");
      onSaved();
    } catch (e) {
      setSaveError(e instanceof ApiError ? e.message : "That configuration could not be saved.");
    } finally {
      setBusy(false);
    }
  };

  const preview = q.data?.preview;

  return (
    <Panel className="overflow-hidden">
      <Head>{series.scope} — {series.label}</Head>

      <div className="grid gap-4 p-3 md:grid-cols-2">
        <div className="grid content-start gap-3">
          <label className="grid gap-1">
            <span className="sw-label">Prefix</span>
            <input className="sw-input" value={form.prefix} spellCheck={false}
              data-testid="numbering-prefix"
              onChange={(e) => setForm((f) => ({ ...f, prefix: e.target.value }))} />
            <span className="sw-sub">
              Letters, digits, spaces and - / _ . Write {"{YYYY}"} or {"{YY}"} where the financial year should
              appear; it is filled in when each document is issued.
            </span>
          </label>

          <label className="grid gap-1">
            <span className="sw-label">Minimum width</span>
            <input className="sw-input" type="number" min={1} max={12} value={form.padding}
              style={{ width: "6rem" }} data-testid="numbering-width"
              onChange={(e) => setForm((f) => ({ ...f, padding: Number(e.target.value) }))} />
            <span className="sw-sub">Zeros are added on the left until the number is this wide. It never cuts a longer number short.</span>
          </label>

          <label className="flex items-start gap-2">
            <input className="sw-check" type="checkbox" checked={form.restartYearly}
              data-testid="numbering-restart"
              onChange={(e) => setForm((f) => ({ ...f, restartYearly: e.target.checked }))} />
            <span>
              <span className="sw-label">Restart each financial year</span>
              <span className="sw-sub block">
                Only possible where the year is in the prefix. Without it the counter would return to 1 into last
                year&apos;s format, and two documents would share a reference — which a tax invoice may not do.
              </span>
            </span>
          </label>

          <label className="grid gap-1">
            <span className="sw-label">Why (kept with the change)</span>
            <input className="sw-input" value={form.note} data-testid="numbering-note"
              placeholder="e.g. the bank cannot read our old reference"
              onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} />
          </label>

          <div className="flex items-center gap-2">
            <button type="button" className="sw-btn sw-btn-primary" disabled={busy || Boolean(q.error)}
              data-testid="numbering-save" onClick={save}>
              {busy ? "Saving…" : "Save format"}
            </button>
            {saved && <span className="sw-sub" data-testid="numbering-saved">{saved}</span>}
          </div>
        </div>

        <div className="grid content-start gap-2">
          {q.error && <ErrorNote>{q.error}</ErrorNote>}
          {saveError && <ErrorNote>{saveError}</ErrorNote>}

          {preview && (
            <div className="sw-note" data-testid="numbering-preview">
              <div className="sw-label">The next document</div>
              <div className="sw-code" style={{ fontSize: "1.0625rem" }}>{preview.next}</div>
              <div className="sw-sub">
                then {preview.following}. It is the number this series was going to issue anyway — changing the
                format does not move the counter, and cannot.
              </div>
              <div className="sw-label mt-2">On {preview.restartsOn}</div>
              <div className="sw-code">{preview.afterRestart}</div>
              <div className="sw-sub">
                {preview.config.restartYearly
                  ? "The counter goes back to 1 and the year in the reference moves with it."
                  : "The counter carries straight on across the year end."}
              </div>
              {preview.changes.length > 0 && (
                <div className="sw-sub mt-2">
                  Changing: {preview.changes.join("; ")}. Now: <span className="sw-code">{preview.current}</span>.
                </div>
              )}
            </div>
          )}

          <History series={series} />
        </div>
      </div>
    </Panel>
  );
}

function History({ series }: { series: Series }) {
  if (series.changes.length === 0) {
    return <p className="sw-sub">This series has never had its format changed.</p>;
  }
  return (
    <div className="sw-scroll">
      <table className="sw-table">
        <caption className="sr-only">Format changes to series {series.scope}, and the number each took effect from</caption>
        <thead>
          <tr>
            <th style={{ width: "7rem" }}>Changed</th>
            <th className="sw-num" style={{ width: "6rem" }}>From no.</th>
            <th>Format</th>
            <th className="hidden md:table-cell">Why</th>
          </tr>
        </thead>
        <tbody>
          {series.changes.map((c) => (
            <tr key={`${c.changedAt}-${c.effectiveFromNo}`}>
              <td>{c.changedAt.slice(0, 10)}</td>
              <td className="sw-num">{c.effectiveFromNo}</td>
              <td className="sw-code">
                {c.from.prefix || "none"}·{c.from.padding} → {c.to.prefix || "none"}·{c.to.padding}
                {c.from.restartYearly !== c.to.restartYearly && (c.to.restartYearly ? " · yearly" : " · continuous")}
              </td>
              <td className="hidden md:table-cell sw-sub">{c.note ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ---------------------------------------------------------------- findings */

/**
 * What has actually been issued, and whether it holds together. A gap is
 * reported rather than thrown: the numbering cannot make one by posting, so a
 * gap is evidence about something else and the reader needs to see it.
 */
function Findings({ series }: { series: Series[] }) {
  const interesting = series.filter((s) => s.integrity.verdict !== "empty");
  if (interesting.length === 0) return null;

  return (
    <Panel className="overflow-hidden">
      <Head>What has been issued</Head>
      <div className="sw-scroll">
        <table className="sw-table">
          <caption className="sr-only">For each series, how many numbers it has issued, the range they cover, and any that are missing or repeated</caption>
          <thead>
            <tr>
              <th style={{ width: "4.5rem" }}>Series</th>
              <th className="sw-num" style={{ width: "5rem" }}>Issued</th>
              <th className="sw-num" style={{ width: "5rem" }}>In force</th>
              <th className="sw-num" style={{ width: "9rem" }}>Reversed or cancelled</th>
              <th style={{ width: "18rem" }}>Range</th>
              <th>Finding</th>
            </tr>
          </thead>
          <tbody>
            {interesting.map((s) => (
              <tr key={s.scope} data-testid={`integrity-${s.scope}`}>
                <td className="sw-code">{s.scope}</td>
                <td className="sw-num">{s.integrity.issued}</td>
                <td className="sw-num">{s.integrity.live}</td>
                <td className="sw-num">{s.integrity.retired}</td>
                <td className="sw-code">
                  {s.integrity.runs.length === 0
                    ? <span className="sw-zero">—</span>
                    : s.integrity.runs.map((r) => (
                        <span key={r.prefix} className="block">{r.from} … {r.to} <span className="sw-sub">({r.count})</span></span>
                      ))}
                </td>
                <td className={s.integrity.verdict === "clean" ? "sw-sub" : undefined}>
                  {s.integrity.note}
                  {s.integrity.gaps.length > 0 && (
                    <> Missing: <span className="sw-code">{s.integrity.gaps.join(", ")}</span>
                      {s.integrity.gapCount > s.integrity.gaps.length && <> and {s.integrity.gapCount - s.integrity.gaps.length} more</>}.</>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="sw-sub px-3 py-2" style={{ borderTop: "1px solid var(--sw-line)" }}>
        A reversed or cancelled document keeps its number, so it is counted as issued and never as missing — that is
        the difference between a document that was corrected and a number nothing at all is filed under. Only the
        second is a finding.
      </p>
    </Panel>
  );
}

function Head({ children }: { children: React.ReactNode }) {
  return (
    <div className="border-b px-3 py-2" style={{ borderColor: "var(--sw-line)", background: "var(--sw-surface-2)" }}>
      <span className="sw-label">{children}</span>
    </div>
  );
}
