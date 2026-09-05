"use client";

import * as React from "react";
import Link from "next/link";
import { api, ApiError, useEntityId, useLedgerQuery } from "@/components/ledger/use-ledger";
import { Figure, PageHead, Panel, ErrorNote, Loading, Empty, StatusChip } from "@/components/ledger/primitives";
import { parseAmount, toInput } from "@/lib/ledger/format";

interface Asset {
  code: string; name: string; category: string; acquiredOn: string;
  method: string; usefulLifeMonths: number;
  costMinor: string; residualMinor: string; accumulatedMinor: string;
  netBookValueMinor: string; depreciatedTo: string | null; status: string;
}
interface Register {
  assets: Asset[];
  totals: { costMinor: string; accumulatedMinor: string; netBookValueMinor: string };
  ledger: { costMinor: string; accumulatedMinor: string; costAgrees: boolean; accumulatedAgrees: boolean };
}

const thisMonth = () => new Date().toISOString().slice(0, 7);

export default function AssetsPage() {
  const entityId = useEntityId();
  const { data, error, loading, reload } = useLedgerQuery<Register>(
    entityId ? `/api/ledger/assets?entityId=${entityId}` : null,
  );
  const [busy, setBusy] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [period, setPeriod] = React.useState(thisMonth);
  const [adding, setAdding] = React.useState(false);

  const act = async (label: string, body: Record<string, unknown>) => {
    setBusy(label); setErr(null); setMsg(null);
    try {
      const r = await api<Record<string, unknown>>("/api/ledger/assets", {
        method: "POST", body: JSON.stringify({ entityId, ...body }),
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

  const depreciate = async () => {
    const r = await act("depreciate", { action: "depreciate", period });
    if (!r) return;
    const n = Number(r.assetsDepreciated);
    const skipped = (r.skipped as { code: string; reason: string }[]) ?? [];
    setMsg(
      n === 0
        ? `Nothing to depreciate in ${period}.` + (skipped.length ? ` ${skipped.length} asset${skipped.length === 1 ? " was" : "s were"} skipped — see below.` : "")
        : `Depreciated ${n} asset${n === 1 ? "" : "s"} for ${period} as ${r.reference}.` +
          (skipped.length ? ` ${skipped.length} skipped.` : ""),
    );
    setSkipped(skipped);
  };
  const [skipped, setSkipped] = React.useState<{ code: string; reason: string }[]>([]);

  if (!entityId) return <Loading label="Choosing an entity…" />;

  return (
    <>
      <PageHead
        title="Fixed assets"
        sub="The register, and the ledger balances it has to agree with. They are separate records on purpose — a register nobody compares to the ledger is a spreadsheet with extra steps."
        actions={
          <>
            <label className="flex items-center gap-1.5">
              <span className="sw-label">Month</span>
              <input
                type="month"
                className="sw-input"
                style={{ width: "9rem" }}
                value={period}
                onChange={(e) => setPeriod(e.target.value)}
                aria-label="Month to depreciate"
              />
            </label>
            <button
              type="button"
              className="sw-btn sw-btn-primary"
              onClick={depreciate}
              aria-disabled={busy === "depreciate" || undefined}
              disabled={busy === "depreciate"}
              data-testid="run-depreciation"
            >
              {busy === "depreciate" ? "Running…" : "Run depreciation"}
            </button>
            <button type="button" className="sw-btn" onClick={() => setAdding((a) => !a)}>
              {adding ? "Cancel" : "Add asset"}
            </button>
          </>
        }
      />

      {err && <ErrorNote>{err}</ErrorNote>}
      {msg && <div className="sw-note mb-3" role="status" data-testid="depreciation-result">{msg}</div>}
      {error && <ErrorNote>{error}</ErrorNote>}

      {adding && (
        <AddAsset
          busy={busy === "add"}
          onAdd={async (asset) => {
            const r = await act("add", { action: "add", asset });
            if (r) { setAdding(false); setMsg(`Added ${asset.code} ${asset.name} to the register.`); }
          }}
        />
      )}

      {skipped.length > 0 && (
        <Panel className="mb-4 p-3">
          <div className="sw-label">Skipped</div>
          <ul className="mt-1.5 space-y-0.5">
            {skipped.map((s) => (
              <li key={s.code} className="sw-sub">
                <span className="sw-code">{s.code}</span> — {s.reason}
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {loading && !data && <Loading />}

      {data && (
        <>
          <Panel className="mb-4 p-4">
            <div className="sw-label">Register against the ledger</div>
            <table className="sw-table mt-3" style={{ maxWidth: "44rem" }}>
              <caption className="sr-only">The fixed asset register against accounts 1500 and 1590</caption>
              <thead>
                <tr>
                  <th />
                  <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Register</th>
                  <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Ledger</th>
                  <th style={{ width: "7rem" }} />
                </tr>
              </thead>
              <tbody>
                <Compare label="Cost" account="1500" a={data.totals.costMinor} b={data.ledger.costMinor} ok={data.ledger.costAgrees} />
                <Compare label="Accumulated depreciation" account="1590" a={data.totals.accumulatedMinor} b={data.ledger.accumulatedMinor} ok={data.ledger.accumulatedAgrees} />
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row" style={{ textAlign: "start" }}>Net book value</th>
                  <td className="sw-num" data-testid="register-nbv">
                    <Figure minor={data.totals.netBookValueMinor} zero="zero" colour={false} />
                  </td>
                  <td colSpan={2} />
                </tr>
              </tfoot>
            </table>
            {(!data.ledger.costAgrees || !data.ledger.accumulatedAgrees) && (
              <p className="sw-sub mt-2" style={{ color: "var(--sw-neg)" }}>
                The register and the ledger disagree. That is a finding, not a display problem — an asset was
                probably registered without being posted, or posted without being registered.
              </p>
            )}
          </Panel>

          {data.assets.length === 0 ? (
            <Empty>Nothing on the register yet.</Empty>
          ) : (
            <Panel className="overflow-hidden">
              <div className="sw-scroll">
                <table className="sw-table">
                  <caption className="sr-only">Fixed asset register</caption>
                  <thead>
                    <tr>
                      <th style={{ width: "6rem" }}>Code</th>
                      <th>Asset</th>
                      <th style={{ width: "7rem" }}>Acquired</th>
                      <th className="hidden md:table-cell" style={{ width: "9rem" }}>Method</th>
                      <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Cost</th>
                      <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Depreciated</th>
                      <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Net book value</th>
                      <th style={{ width: "7rem" }}>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.assets.map((a) => (
                      <tr key={a.code}>
                        <td className="sw-code">{a.code}</td>
                        <td className="max-w-0 truncate">{a.name}</td>
                        <td>{a.acquiredOn}</td>
                        <td className="hidden md:table-cell" style={{ color: "var(--sw-fg-muted)" }}>
                          {a.method === "STRAIGHT_LINE" ? "Straight line" : "Reducing balance"}
                          <span className="sw-sub"> · {a.usefulLifeMonths}m</span>
                        </td>
                        <td className="sw-num"><Figure minor={a.costMinor} colour={false} /></td>
                        <td className="sw-num">
                          <Figure minor={a.accumulatedMinor} colour={false} />
                          {a.depreciatedTo && (
                            <span className="block text-[0.6875rem]" style={{ color: "var(--sw-fg-muted)" }}>to {a.depreciatedTo}</span>
                          )}
                        </td>
                        <td className="sw-num"><Figure minor={a.netBookValueMinor} /></td>
                        <td><StatusChip status={a.status} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="sw-sub px-3 py-2" style={{ borderTop: "1px solid var(--sw-line)" }}>
                Depreciation posts one month at a time and is never recomputed — a change in estimate is
                prospective, so prior periods stand.{" "}
                <Link href="/accounting/accounts/1590" className="sw-link">Open accumulated depreciation</Link>.
              </p>
            </Panel>
          )}
        </>
      )}
    </>
  );
}

function Compare({ label, account, a, b, ok }: {
  label: string; account: string; a: string; b: string; ok: boolean;
}) {
  return (
    <tr>
      <th scope="row" style={{ textAlign: "start", fontWeight: 400 }}>{label}</th>
      <td className="sw-num"><Figure minor={a} zero="zero" colour={false} /></td>
      <td className="sw-num"><Figure minor={b} zero="zero" colour={false} /></td>
      <td>
        <Link href={`/accounting/accounts/${account}`} className="sw-link">{account}</Link>{" "}
        <span className={`sw-chip ${ok ? "sw-chip-ok" : "sw-chip-bad"}`}>{ok ? "agrees" : "differs"}</span>
      </td>
    </tr>
  );
}

/**
 * INTANGIBLE is last and is not like the others.
 *
 * The rest are kinds of property, plant and equipment and all post to the same
 * three accounts. An intangible posts to 1560, 1570 and 6610 instead, appears
 * under its own note, and draws the IAS 38 policy rather than the IAS 16 one —
 * so choosing it here is the judgement IAS 38.54 asks somebody to make, not a
 * label on a row. A capitalised licence registered as IT amortises correctly
 * and is captioned, accounted and disclosed as plant.
 */
const CATEGORIES = ["EQUIPMENT", "VEHICLES", "FURNITURE", "IT", "BUILDINGS", "LEASEHOLD", "INTANGIBLE"];

const CATEGORY_NOTE: Record<string, string> = {
  INTANGIBLE:
    "Software, licences, and development costs that met IAS 38.57. Posts to intangible assets (1560), " +
    "amortises through 6610, and is disclosed apart from property, plant and equipment. An intangible with no " +
    "foreseeable end to its life is not amortised at all and does not belong on this register.",
};

function AddAsset({ busy, onAdd }: {
  busy: boolean;
  onAdd: (a: {
    code: string; name: string; category: string; acquiredOn: string;
    costMinor: string; residualMinor: string; method: "STRAIGHT_LINE" | "REDUCING_BALANCE";
    usefulLifeMonths: number; ratePercent?: number;
  }) => void;
}) {
  const [f, setF] = React.useState({
    code: "", name: "", category: "EQUIPMENT",
    acquiredOn: new Date().toISOString().slice(0, 10),
    cost: "", residual: "", method: "STRAIGHT_LINE" as "STRAIGHT_LINE" | "REDUCING_BALANCE",
    life: "60", rate: "",
  });
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));

  const cost = parseAmount(f.cost);
  const residual = parseAmount(f.residual) ?? 0n;
  const life = Number(f.life);

  const blocker =
    !f.code.trim() ? "Give the asset a code." :
    !f.name.trim() ? "Give the asset a name." :
    cost === null || cost <= 0n ? "What did it cost?" :
    residual === null || residual > cost ? "Residual value cannot exceed the cost." :
    !Number.isInteger(life) || life <= 0 ? "Useful life is a whole number of months." :
    f.method === "REDUCING_BALANCE" && !(Number(f.rate) > 0) ? "A reducing-balance asset needs an annual rate." :
    null;

  return (
    <Panel className="mb-4 p-4">
      <div className="sw-label">Add an asset</div>
      <p className="sw-sub mt-1 max-w-[70ch]">
        This records the estimates — life, method, residual. The purchase itself is a separate posting; the
        register is meant to be compared against it, not to replace it.
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Code"><input className="sw-input" value={f.code} onChange={(e) => set("code", e.target.value)} placeholder="FA-001" /></Field>
        <Field label="Name"><input className="sw-input" value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="Delivery van" /></Field>
        <Field label="Category">
          <select className="sw-select" value={f.category} onChange={(e) => set("category", e.target.value)}>
            {CATEGORIES.map((c) => <option key={c} value={c}>{c.toLowerCase()}</option>)}
          </select>
          {CATEGORY_NOTE[f.category] && (
            <span className="sw-sub mt-1 block" style={{ maxWidth: "40ch" }}>{CATEGORY_NOTE[f.category]}</span>
          )}
        </Field>
        <Field label="Acquired"><input type="date" className="sw-input" value={f.acquiredOn} onChange={(e) => set("acquiredOn", e.target.value)} /></Field>
        <Field label="Cost"><input className="sw-input sw-cell-num" inputMode="decimal" value={f.cost} onChange={(e) => set("cost", e.target.value)} placeholder="120,000.00" /></Field>
        <Field label="Residual value"><input className="sw-input sw-cell-num" inputMode="decimal" value={f.residual} onChange={(e) => set("residual", e.target.value)} placeholder="0.00" /></Field>
        <Field label="Method">
          <select className="sw-select" value={f.method} onChange={(e) => set("method", e.target.value)}>
            <option value="STRAIGHT_LINE">Straight line</option>
            <option value="REDUCING_BALANCE">Reducing balance</option>
          </select>
        </Field>
        {f.method === "STRAIGHT_LINE" ? (
          <Field label="Useful life (months)"><input className="sw-input sw-cell-num" inputMode="numeric" value={f.life} onChange={(e) => set("life", e.target.value)} /></Field>
        ) : (
          <Field label="Annual rate (%)"><input className="sw-input sw-cell-num" inputMode="decimal" value={f.rate} onChange={(e) => set("rate", e.target.value)} placeholder="25" /></Field>
        )}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="sw-btn sw-btn-primary"
          aria-disabled={blocker !== null || busy || undefined}
          disabled={blocker !== null || busy}
          data-testid="save-asset"
          onClick={() => onAdd({
            code: f.code.trim(), name: f.name.trim(), category: f.category, acquiredOn: f.acquiredOn,
            costMinor: (cost as bigint).toString(), residualMinor: residual.toString(),
            method: f.method, usefulLifeMonths: life,
            ...(f.method === "REDUCING_BALANCE" ? { ratePercent: Number(f.rate) } : {}),
          })}
        >
          {busy ? "Saving…" : "Add to register"}
        </button>
        {blocker && <span className="sw-sub" role="status" data-testid="asset-blocker">{blocker}</span>}
        {!blocker && cost !== null && f.method === "STRAIGHT_LINE" && (
          <span className="sw-sub">
            About {toInput((cost - residual) / BigInt(life || 1))} a month over {life} months.
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
