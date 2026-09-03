"use client";

import * as React from "react";
import Link from "next/link";
import { useAppState } from "@/lib/app-state";
import { api, ApiError, useEntityId, useLedgerQuery } from "@/components/ledger/use-ledger";
import { Figure, PageHead, Panel, ErrorNote, Loading, StatusChip } from "@/components/ledger/primitives";

/**
 * The report designer.
 *
 * The screen is three things at once: the layouts this entity holds, the rows
 * of the one being edited, and the report those rows produce. The preview is
 * rendered by the same server code the saved report uses — including its
 * refusals — so the row that will not save is refused here, next to the row,
 * rather than after a save that looked like it worked.
 *
 * The coverage block above the preview is the part that earns the screen. A
 * layout that omits an account still adds up and still looks right, so the
 * omission is stated in words at the top of the report rather than left to be
 * noticed in a total.
 */

type RowKind = "accounts" | "total" | "heading" | "spacer";
type Basis = "PROFIT" | "BALANCE";

interface LayoutRow {
  key?: string; label: string; kind: RowKind;
  from?: string; to?: string; codes?: string[]; of?: string[];
  invert?: boolean; bold?: boolean;
}
interface SavedLayout {
  id: string; entityId: string; code: string; name: string;
  basis: Basis; rows: LayoutRow[]; status: string; createdAt: string; updatedAt: string;
}
interface RenderedRow {
  key: string | null; label: string; kind: RowKind;
  valueMinor: string | null; invert: boolean; bold: boolean;
  codes: string[]; of: string[];
}
interface CoverageAccount { code: string; name: string; type: string; balanceMinor: string }
interface Rendered {
  code: string; name: string; basis: Basis;
  from: string | null; to: string; currency: string;
  rows: RenderedRow[];
  bottomLineMinor: string | null;
  netProfitMinor: string | null;
  bottomLineDifferenceMinor: string | null;
  coverage: {
    considered: number; matched: number;
    unmatched: CoverageAccount[]; unmatchedTotalMinor: string;
    overlapping: CoverageAccount[];
  };
  warnings: string[];
}

/** The editor holds text, because a half-typed range is still a thing on screen. */
interface EditRow {
  id: number;
  key: string; label: string; kind: RowKind;
  from: string; to: string; codes: string; of: string;
  invert: boolean; bold: boolean;
}

let nextId = 1;
const blank = (kind: RowKind = "accounts"): EditRow => ({
  id: nextId++, key: "", label: "", kind, from: "", to: "", codes: "", of: "", invert: false, bold: false,
});

const split = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

function toEditRows(rows: LayoutRow[]): EditRow[] {
  return rows.map((r) => ({
    id: nextId++,
    key: r.key ?? "", label: r.label ?? "", kind: r.kind,
    from: r.from ?? "", to: r.to ?? "",
    codes: (r.codes ?? []).join(", "), of: (r.of ?? []).join(", "),
    invert: r.invert === true, bold: r.bold === true,
  }));
}

/** Only the fields the row's kind actually uses — the rest are noise on the wire. */
function toLayoutRows(rows: EditRow[]): LayoutRow[] {
  return rows.map((r) => {
    const out: LayoutRow = { label: r.label, kind: r.kind };
    if (r.key.trim()) out.key = r.key.trim();
    if (r.invert) out.invert = true;
    if (r.bold) out.bold = true;
    if (r.kind === "accounts") {
      if (split(r.codes).length) out.codes = split(r.codes);
      else { out.from = r.from.trim(); out.to = r.to.trim(); }
    }
    if (r.kind === "total") out.of = split(r.of);
    return out;
  });
}

function ytd() {
  const now = new Date();
  return { from: `${now.getUTCFullYear()}-01-01`, to: now.toISOString().slice(0, 10) };
}

/** A fresh page starts empty rather than with rows nobody asked for. */
const NO_ROWS: EditRow[] = [];

export default function LayoutsPage() {
  const entityId = useEntityId();
  const { entities } = useAppState();

  const [range, setRange] = React.useState(ytd);
  const [code, setCode] = React.useState("");
  const [name, setName] = React.useState("");
  const [basis, setBasis] = React.useState<Basis>("PROFIT");
  const [rows, setRows] = React.useState<EditRow[]>(NO_ROWS);
  const [loaded, setLoaded] = React.useState<string | null>(null);

  const [err, setErr] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);

  const [preview, setPreview] = React.useState<Rendered | null>(null);
  const [previewErr, setPreviewErr] = React.useState<string | null>(null);
  const [copyTo, setCopyTo] = React.useState("");

  const list = useLedgerQuery<{ layouts: SavedLayout[]; starters: { code: string; name: string; basis: Basis }[] }>(
    entityId ? `/api/ledger/layouts?entityId=${entityId}&archived=1` : null,
  );

  const others = React.useMemo(
    () => entities.filter((e) => e.id !== entityId),
    [entities, entityId],
  );
  React.useEffect(() => {
    if (!copyTo && others.length) setCopyTo(others[0].id);
  }, [others, copyTo]);

  // The preview is the same render the saved report gets, so the refusal that
  // would have stopped a save arrives while the row is still on screen.
  const wire = JSON.stringify(toLayoutRows(rows));
  React.useEffect(() => {
    if (!entityId || !rows.length) { setPreview(null); setPreviewErr(null); return; }
    let cancelled = false;
    const t = setTimeout(() => {
      api<Rendered>("/api/ledger/layouts", {
        method: "POST",
        body: JSON.stringify({
          action: "preview",
          entityId,
          layout: { code: code || "DRAFT", name: name || "Draft layout", basis, rows: JSON.parse(wire) },
          from: basis === "PROFIT" ? range.from : undefined,
          to: range.to,
        }),
      })
        .then((r) => { if (!cancelled) { setPreview(r); setPreviewErr(null); } })
        .catch((e: Error) => { if (!cancelled) { setPreview(null); setPreviewErr(e.message); } });
    }, 350);
    return () => { cancelled = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityId, wire, basis, range.from, range.to]);

  const patch = (id: number, change: Partial<EditRow>) =>
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...change } : r)));

  const move = (id: number, by: number) =>
    setRows((rs) => {
      const i = rs.findIndex((r) => r.id === id);
      const j = i + by;
      if (i < 0 || j < 0 || j >= rs.length) return rs;
      const out = [...rs];
      [out[i], out[j]] = [out[j], out[i]];
      return out;
    });

  const open = (l: SavedLayout) => {
    setCode(l.code); setName(l.name); setBasis(l.basis);
    setRows(toEditRows(l.rows));
    setLoaded(l.code);
    setErr(null);
    setMsg(`Editing ${l.code} — ${l.name}. Nothing is saved until you save it.`);
  };

  const fresh = () => {
    setCode(""); setName(""); setBasis("PROFIT");
    setRows([{ ...blank("heading"), label: "Trading" }, blank("accounts")]);
    setLoaded(null);
    setErr(null); setMsg("A new layout. Give it a code and a name, then add rows.");
  };

  const act = async <T,>(what: string, body: Record<string, unknown>, done: (r: T) => string) => {
    setErr(null); setMsg(null); setBusy(what);
    try {
      const r = await api<T>("/api/ledger/layouts", { method: "POST", body: JSON.stringify({ ...body, entityId }) });
      setMsg(done(r));
      list.reload();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "That did not work.");
    } finally {
      setBusy(null);
    }
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!code.trim()) { setErr("Give the layout a code, such as MGMT_PL. It is what a copy to another entity is filed under."); return; }
    if (!name.trim()) { setErr("Give the layout a name. It is what the list of layouts shows."); return; }
    void act<SavedLayout>(
      "save",
      { action: "save", code: code.trim(), name: name.trim(), basis, rows: toLayoutRows(rows) },
      (r) => { setLoaded(r.code); setCode(r.code); return `Saved ${r.code} — ${r.name}, ${r.rows.length} row${r.rows.length === 1 ? "" : "s"}.`; },
    );
  };

  if (!entityId) return <Loading label="Choosing an entity…" />;

  return (
    <>
      <PageHead
        title="Report designer"
        sub="Rows over account ranges, saved as data. A management pack can be built here without anyone editing code, and copied to another entity. Every render says which accounts no row picked up — a layout that omits one still adds up."
        actions={
          <>
            <label className="flex items-center gap-1.5">
              <span className="sw-label">From</span>
              <input type="date" className="sw-input" style={{ width: "9.5rem" }} value={range.from}
                disabled={basis === "BALANCE"}
                aria-describedby={basis === "BALANCE" ? "basis-note" : undefined}
                onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))} />
            </label>
            <label className="flex items-center gap-1.5">
              <span className="sw-label">{basis === "BALANCE" ? "As at" : "To"}</span>
              <input type="date" className="sw-input" style={{ width: "9.5rem" }} value={range.to}
                onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))} />
            </label>
          </>
        }
      />

      {err && <ErrorNote>{err}</ErrorNote>}
      {msg && <div className="sw-note mb-3" role="status" data-testid="layout-result">{msg}</div>}
      {list.error && <ErrorNote>{list.error}</ErrorNote>}

      <Panel className="mb-4 overflow-hidden">
        <Band>
          Saved layouts
          <span className="ms-2" style={{ textTransform: "none", letterSpacing: 0 }}>
            <button type="button" className="sw-btn sw-btn-sm" onClick={fresh} data-testid="new-layout">New layout</button>
            <button type="button" className="sw-btn sw-btn-sm ms-2" disabled={busy !== null}
              onClick={() => void act<{ created: string[]; skipped: string[] }>(
                "seed", { action: "seed" },
                (r) => r.created.length
                  ? `Seeded ${r.created.join(" and ")}. Open one and change a row to see the coverage report react.`
                  : `${r.skipped.join(" and ")} already exist here, so nothing was replaced.`,
              )}
              data-testid="seed-layouts"
            >
              {busy === "seed" ? "Seeding…" : "Add starting layouts"}
            </button>
          </span>
        </Band>
        <div className="sw-scroll">
          <table className="sw-table">
            <caption className="sr-only">Report layouts saved for this entity</caption>
            <thead>
              <tr>
                <th style={{ width: "9rem" }}>Code</th>
                <th>Name</th>
                <th style={{ width: "7rem" }}>Basis</th>
                <th className="sw-num" style={{ width: "5rem" }}>Rows</th>
                <th style={{ width: "7rem" }}>Status</th>
                <th style={{ width: "16rem" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {list.loading && !list.data && (
                <tr><td colSpan={6} className="sw-sub">Loading…</td></tr>
              )}
              {list.data?.layouts.length === 0 && (
                <tr>
                  <td colSpan={6} className="sw-sub">
                    No layouts yet. Add the starting pair above, or begin a new one — the two statements on the{" "}
                    <Link href="/accounting/statements" className="sw-link">statements page</Link> stay whatever you do here.
                  </td>
                </tr>
              )}
              {list.data?.layouts.map((l) => (
                <tr key={l.id} data-testid={`layout-${l.code}`}>
                  <td className="sw-code">{l.code}</td>
                  <td>{l.name}</td>
                  <td>{l.basis === "PROFIT" ? "Profit and loss" : "Balance sheet"}</td>
                  <td className="sw-num">{l.rows.length}</td>
                  <td><StatusChip status={l.status} /></td>
                  <td>
                    <button type="button" className="sw-btn sw-btn-sm" onClick={() => open(l)}
                      data-testid={`edit-${l.code}`}>
                      {loaded === l.code ? "Reload" : "Edit"}
                    </button>
                    <button type="button" className="sw-btn sw-btn-sm ms-2" disabled={busy !== null}
                      onClick={() => void act<SavedLayout>(
                        "archive",
                        { action: "archive", code: l.code, status: l.status === "active" ? "archived" : "active" },
                        (r) => `${r.code} is now ${r.status}.`,
                      )}
                    >
                      {l.status === "active" ? "Archive" : "Restore"}
                    </button>
                    {others.length > 0 && (
                      <button type="button" className="sw-btn sw-btn-sm ms-2" disabled={busy !== null}
                        onClick={() => void act<{ toEntityId: string; emptyRows: string[] }>(
                          "copy",
                          { action: "duplicate", code: l.code, toEntityId: copyTo },
                          (r) => `Copied ${l.code} to ${nameOfEntity(entities, r.toEntityId)}.` +
                            (r.emptyRows.length
                              ? ` ${r.emptyRows.join(", ")} matched no account there and will render blank.`
                              : ""),
                        )}
                        data-testid={`copy-${l.code}`}
                      >
                        Copy
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {others.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 px-3 py-2" style={{ borderTop: "1px solid var(--sw-line)" }}>
            <label className="flex items-center gap-1.5">
              <span className="sw-label">Copy to entity</span>
              <select className="sw-select sw-select-sm" style={{ width: "16rem" }} value={copyTo}
                onChange={(e) => setCopyTo(e.target.value)} data-testid="copy-target">
                {others.map((e) => <option key={e.id} value={e.id}>{e.legalNameEn}</option>)}
              </select>
            </label>
            <span className="sw-sub">
              A row naming an account the other entity does not have is refused rather than copied, because it would
              render there as a silent zero.
            </span>
          </div>
        )}
      </Panel>

      <div className="grid gap-4 xl:grid-cols-2">
        {/* ------------------------------------------------------------ editor */}
        <Panel className="overflow-hidden">
          <Band>Rows</Band>
          <form onSubmit={submit}>
            <div className="grid gap-2 px-3 py-3 sm:grid-cols-3">
              <label className="grid gap-1">
                <span className="sw-label">Code</span>
                <input className="sw-input" placeholder="MGMT_PL" value={code}
                  onChange={(e) => setCode(e.target.value.toUpperCase())} data-testid="layout-code" />
              </label>
              <label className="grid gap-1">
                <span className="sw-label">Name</span>
                <input className="sw-input" placeholder="Management profit and loss" value={name}
                  onChange={(e) => setName(e.target.value)} data-testid="layout-name" />
              </label>
              <label className="grid gap-1">
                <span className="sw-label">Basis</span>
                <select className="sw-select" value={basis} onChange={(e) => setBasis(e.target.value as Basis)}
                  data-testid="layout-basis">
                  <option value="PROFIT">Profit and loss — a period</option>
                  <option value="BALANCE">Balance sheet — a date</option>
                </select>
              </label>
              <p className="sw-sub sm:col-span-3" id="basis-note">
                A profit layout is drawn over the dates above; a balance layout is drawn as at the later one, and the
                From date does not apply to it. Invert flips the sign for presentation: revenue and liabilities are
                credit balances, so they read positively inverted, and a cost inverted reads as the deduction it is —
                which is what lets a total be a plain sum of the rows above it.
              </p>
            </div>

            <div className="sw-scroll" style={{ borderTop: "1px solid var(--sw-line)" }}>
              <table className="sw-table sw-grid" data-testid="row-editor">
                <caption className="sr-only">The rows of this layout, in the order they render</caption>
                <thead>
                  <tr>
                    <th style={{ width: "2.5rem" }}>#</th>
                    <th style={{ width: "8rem" }}>Kind</th>
                    <th style={{ width: "7rem" }}>Key</th>
                    <th style={{ minWidth: "10rem" }}>Label</th>
                    <th style={{ width: "5rem" }}>From</th>
                    <th style={{ width: "5rem" }}>To</th>
                    <th style={{ width: "8rem" }}>Codes</th>
                    <th style={{ width: "9rem" }}>Adds up</th>
                    <th style={{ width: "4rem" }}>Invert</th>
                    <th style={{ width: "3.5rem" }}>Bold</th>
                    <th style={{ width: "7rem" }}>Order</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 && (
                    <tr>
                      <td colSpan={11} className="sw-sub" style={{ padding: "0 0.625rem" }}>
                        No rows. Open a saved layout above, or start a new one.
                      </td>
                    </tr>
                  )}
                  {rows.map((r, i) => (
                    <tr key={r.id} data-testid={`row-${i + 1}`}>
                      <td className="sw-code" style={{ paddingInline: "0.5rem" }}>{i + 1}</td>
                      <td>
                        <select className="sw-cell" aria-label={`Row ${i + 1} kind`} value={r.kind}
                          onChange={(e) => patch(r.id, { kind: e.target.value as RowKind })}>
                          <option value="accounts">accounts</option>
                          <option value="total">total</option>
                          <option value="heading">heading</option>
                          <option value="spacer">spacer</option>
                        </select>
                      </td>
                      <td>
                        <input className="sw-cell" aria-label={`Row ${i + 1} key`} placeholder="revenue"
                          value={r.key} onChange={(e) => patch(r.id, { key: e.target.value })} />
                      </td>
                      <td>
                        <input className="sw-cell" aria-label={`Row ${i + 1} label`} placeholder="Revenue"
                          value={r.label} disabled={r.kind === "spacer"}
                          onChange={(e) => patch(r.id, { label: e.target.value })} />
                      </td>
                      <td>
                        <input className="sw-cell sw-cell-num" aria-label={`Row ${i + 1} range starts at`}
                          placeholder="4000" value={r.from} disabled={r.kind !== "accounts"}
                          onChange={(e) => patch(r.id, { from: e.target.value })} />
                      </td>
                      <td>
                        <input className="sw-cell sw-cell-num" aria-label={`Row ${i + 1} range ends at`}
                          placeholder="4999" value={r.to} disabled={r.kind !== "accounts"}
                          onChange={(e) => patch(r.id, { to: e.target.value })} />
                      </td>
                      <td>
                        <input className="sw-cell" aria-label={`Row ${i + 1} account codes`} placeholder="6100, 6150"
                          value={r.codes} disabled={r.kind !== "accounts"}
                          onChange={(e) => patch(r.id, { codes: e.target.value })} />
                      </td>
                      <td>
                        <input className="sw-cell" aria-label={`Row ${i + 1} adds up the keys`}
                          placeholder="revenue, cost_of_sales" value={r.of} disabled={r.kind !== "total"}
                          onChange={(e) => patch(r.id, { of: e.target.value })} />
                      </td>
                      <td style={{ textAlign: "center" }}>
                        <input type="checkbox" aria-label={`Row ${i + 1} inverts its sign`} checked={r.invert}
                          disabled={r.kind === "heading" || r.kind === "spacer"}
                          onChange={(e) => patch(r.id, { invert: e.target.checked })} />
                      </td>
                      <td style={{ textAlign: "center" }}>
                        <input type="checkbox" aria-label={`Row ${i + 1} is bold`} checked={r.bold}
                          onChange={(e) => patch(r.id, { bold: e.target.checked })} />
                      </td>
                      <td style={{ whiteSpace: "nowrap" }}>
                        <button type="button" className="sw-icon-btn" aria-label={`Move row ${i + 1} up`}
                          onClick={() => move(r.id, -1)}>↑</button>
                        <button type="button" className="sw-icon-btn" aria-label={`Move row ${i + 1} down`}
                          onClick={() => move(r.id, 1)}>↓</button>
                        <button type="button" className="sw-icon-btn" aria-label={`Delete row ${i + 1}`}
                          onClick={() => setRows((rs) => rs.filter((x) => x.id !== r.id))}>×</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex flex-wrap items-center gap-2 px-3 py-2" style={{ borderTop: "1px solid var(--sw-line)" }}>
              <button type="button" className="sw-btn" onClick={() => setRows((rs) => [...rs, blank("accounts")])}
                data-testid="add-row">Add a row</button>
              <button type="button" className="sw-btn" onClick={() => setRows((rs) => [...rs, blank("total")])}>
                Add a total
              </button>
              <button type="button" className="sw-btn" onClick={() => setRows((rs) => [...rs, blank("spacer")])}>
                Add a spacer
              </button>
              <span className="grow" />
              <button type="submit" className="sw-btn sw-btn-primary" disabled={busy !== null} data-testid="save-layout">
                {busy === "save" ? "Saving…" : loaded ? `Save ${loaded}` : "Save layout"}
              </button>
            </div>
          </form>
        </Panel>

        {/* ----------------------------------------------------------- preview */}
        <Panel className="overflow-hidden">
          <Band>
            Preview — {basis === "PROFIT" ? `${range.from} to ${range.to}` : `as at ${range.to}`}
          </Band>

          {previewErr && (
            <div className="p-3">
              <div className="sw-error" role="alert" data-testid="preview-error">{previewErr}</div>
              <p className="sw-sub mt-2">
                The preview is the same render the saved report gets, so this is the sentence a save would have
                returned. Nothing has been written.
              </p>
            </div>
          )}

          {!previewErr && !preview && (
            <p className="sw-sub p-3">Add a row to see the report it produces.</p>
          )}

          {preview && (
            <>
              {preview.warnings.length > 0 && (
                <div className="grid gap-2 p-3" style={{ borderBottom: "1px solid var(--sw-line)" }}>
                  {preview.warnings.map((w, i) => (
                    <div key={i} className="sw-error" role="alert" data-testid="coverage-warning">{w}</div>
                  ))}
                </div>
              )}

              <div className="flex flex-wrap items-center gap-3 px-3 py-2"
                style={{ borderBottom: "1px solid var(--sw-line)", background: "var(--sw-surface-2)" }}>
                <span className={`sw-chip ${preview.coverage.unmatched.length ? "sw-chip-bad" : "sw-chip-ok"}`}
                  data-testid="coverage-chip">
                  {preview.coverage.matched} of {preview.coverage.considered} accounts covered
                </span>
                {preview.basis === "PROFIT" && (
                  <span className={`sw-chip ${preview.bottomLineDifferenceMinor === "0" ? "sw-chip-ok" : "sw-chip-bad"}`}
                    data-testid="bottom-line-chip">
                    {preview.bottomLineDifferenceMinor === "0"
                      ? "agrees with the profit and loss"
                      : "disagrees with the profit and loss"}
                  </span>
                )}
                {preview.basis === "PROFIT" && preview.netProfitMinor !== null && (
                  <span className="sw-sub">
                    Net profit for these dates is{" "}
                    <Figure minor={preview.netProfitMinor} currency={preview.currency} zero="zero" colour={false} />,
                    and this layout ends at{" "}
                    <Figure minor={preview.bottomLineMinor ?? "0"} currency={preview.currency} zero="zero" colour={false} />.
                  </span>
                )}
              </div>

              <div className="sw-scroll">
                <table className="sw-table" data-testid="preview-table">
                  <caption className="sr-only">
                    {preview.name} {preview.from ? `from ${preview.from} to ${preview.to}` : `as at ${preview.to}`}
                  </caption>
                  <thead>
                    <tr>
                      <th>Line</th>
                      <th className="sw-num" style={{ width: "5rem" }}>Accounts</th>
                      <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>{preview.currency}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.rows.map((r, i) => {
                      if (r.kind === "spacer") {
                        return <tr key={i}><td colSpan={3} style={{ height: "0.75rem" }} /></tr>;
                      }
                      if (r.kind === "heading") {
                        return (
                          <tr key={i}>
                            <td colSpan={3} style={{ background: "var(--sw-surface-2)" }}>
                              <span className="sw-label">{r.label}</span>
                            </td>
                          </tr>
                        );
                      }
                      const weight = r.bold ? 600 : 400;
                      return (
                        <tr key={i} data-testid={`preview-${r.key ?? i}`}>
                          <th scope="row" style={{
                            fontWeight: weight,
                            paddingInlineStart: r.kind === "total" ? "0.625rem" : "1.25rem",
                            borderTop: r.kind === "total" ? "1px solid var(--sw-line-strong)" : undefined,
                          }}>
                            {r.label}
                            {r.kind === "total" && (
                              <span className="sw-sub ms-2">{r.of.join(" + ")}</span>
                            )}
                          </th>
                          <td className="sw-num sw-zero" style={{
                            borderTop: r.kind === "total" ? "1px solid var(--sw-line-strong)" : undefined,
                          }}>
                            {r.kind === "accounts" ? r.codes.length : ""}
                          </td>
                          <td className="sw-num" style={{
                            fontWeight: weight,
                            borderTop: r.kind === "total" ? "1px solid var(--sw-line-strong)" : undefined,
                          }}>
                            <Figure minor={r.valueMinor} currency={preview.currency} zero="zero" />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {preview.coverage.unmatched.length > 0 && (
                <div className="sw-scroll" style={{ borderTop: "1px solid var(--sw-line)" }}>
                  <table className="sw-table" data-testid="uncovered-table">
                    <caption className="sr-only">Accounts carrying a balance that no row of this layout picked up</caption>
                    <thead>
                      <tr>
                        <th colSpan={3}>In no row of this layout</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.coverage.unmatched.map((u) => (
                        <tr key={u.code} data-testid={`uncovered-${u.code}`}>
                          <td className="sw-code" style={{ width: "5rem" }}>{u.code}</td>
                          <td>{u.name}</td>
                          <td className="sw-num" style={{ width: "var(--sw-col-amount)" }}>
                            <Figure minor={u.balanceMinor} currency={preview.currency} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <th scope="row" colSpan={2} style={{ textAlign: "end" }}>Together</th>
                        <td className="sw-num">
                          <Figure minor={preview.coverage.unmatchedTotalMinor} currency={preview.currency} zero="zero" />
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}

              <p className="sw-sub px-3 py-2" style={{ borderTop: "1px solid var(--sw-line)" }} data-testid="preview-note">
                The figures are the same read as the{" "}
                <Link href="/accounting/statements" className="sw-link">statements</Link> for these dates, so this
                report cannot disagree with them by accident — only by leaving an account out, which is what the
                coverage line above is counting.
              </p>
            </>
          )}
        </Panel>
      </div>
    </>
  );
}

function nameOfEntity(entities: { id: string; legalNameEn: string }[], id: string): string {
  return entities.find((e) => e.id === id)?.legalNameEn ?? id;
}

function Band({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2"
      style={{ borderColor: "var(--sw-line)", background: "var(--sw-surface-2)" }}>
      <span className="sw-label">{children}</span>
    </div>
  );
}
