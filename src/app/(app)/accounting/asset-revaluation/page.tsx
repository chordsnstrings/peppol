"use client";

import * as React from "react";
import { api, ApiError, useEntityId, useLedgerQuery } from "@/components/ledger/use-ledger";
import { Figure, PageHead, Panel, ErrorNote, Loading, Empty, StatusChip } from "@/components/ledger/primitives";
import { parseAmount } from "@/lib/ledger/format";

interface Event {
  seq: number; on: string; kind: string;
  carryingBeforeMinor: string; fairValueMinor: string; movementMinor: string;
  toSurplusMinor: string; toProfitMinor: string; surplusAfterMinor: string;
  basis: string | null; entryId: string | null;
}
interface AssetRow {
  code: string; name: string; status: string;
  carryingMinor: string; surplusMinor: string; impairedMinor: string;
  events: Event[];
}
interface Register {
  assets: AssetRow[];
  totals: { registerSurplusMinor: string; impairedMinor: string };
  reconciliation: {
    registerSurplusMinor: string; ledgerSurplusMinor: string; differenceMinor: string;
    ledgerImpairmentMinor: string; agrees: boolean;
  };
}

const today = () => new Date().toISOString().slice(0, 10);

const KIND_WORD: Record<string, string> = {
  REVALUATION: "revaluation",
  IMPAIRMENT: "impairment",
  REVERSAL: "reversal",
};

export default function AssetRevaluationPage() {
  const entityId = useEntityId();
  const { data, error, loading, reload } = useLedgerQuery<Register>(
    entityId ? `/api/ledger/asset-revaluation?entityId=${entityId}` : null,
  );
  const [busy, setBusy] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [openCode, setOpenCode] = React.useState<string | null>(null);
  const [form, setForm] = React.useState({ code: "", on: today(), value: "", basis: "" });
  const [formErr, setFormErr] = React.useState<string | null>(null);

  const act = async (label: string, body: Record<string, unknown>) => {
    setBusy(label); setErr(null); setMsg(null);
    try {
      const r = await api<Record<string, unknown>>("/api/ledger/asset-revaluation", {
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

  if (!entityId) return <Loading label="Choosing an entity…" />;
  const rec = data?.reconciliation;

  return (
    <>
      <PageHead
        title="Revaluation and impairment"
        sub={
          "An increase goes to the revaluation surplus in equity — except so far as it reverses a fall charged to " +
          "profit before, which goes back to profit. A fall is charged to profit — except so far as this asset " +
          "already carries a surplus, which is used first. Both exceptions are about this asset alone: one " +
          "building's surplus cannot absorb another building's fall."
        }
      />

      {err && <ErrorNote>{err}</ErrorNote>}
      {msg && <div className="sw-note mb-3" role="status" data-testid="revaluation-result">{msg}</div>}
      {error && <ErrorNote>{error}</ErrorNote>}

      <Panel className="mb-4 p-4">
        <div className="sw-label">Value an asset</div>
        <div className="mt-3 grid gap-3 sm:grid-cols-4">
          <label className="block">
            <span className="sw-label">Asset</span>
            <input className="sw-input mt-1" value={form.code} placeholder="FA-1"
              onChange={(e) => setForm({ ...form, code: e.target.value })} />
          </label>
          <label className="block">
            <span className="sw-label">Valued on</span>
            <input type="date" className="sw-input mt-1" value={form.on}
              onChange={(e) => setForm({ ...form, on: e.target.value })} />
          </label>
          <label className="block">
            <span className="sw-label">Assessed value</span>
            <input className="sw-input sw-num mt-1" value={form.value} placeholder="0.00"
              onChange={(e) => setForm({ ...form, value: e.target.value })} />
          </label>
          <label className="block">
            <span className="sw-label">Basis</span>
            <input className="sw-input mt-1" value={form.basis} placeholder="Valuer's report"
              onChange={(e) => setForm({ ...form, basis: e.target.value })} />
          </label>
        </div>
        {formErr && <div className="sw-error mt-2" role="alert">{formErr}</div>}
        <button type="button" className="sw-btn sw-btn-primary mt-3" data-testid="revalue-asset"
          disabled={busy === "revalue"}
          onClick={async () => {
            if (!form.code.trim()) { setFormErr("Which asset?"); return; }
            const v = parseAmount(form.value, "AED");
            if (v === null || v < 0n) { setFormErr("The assessed value has to be an amount, and not a negative one."); return; }
            setFormErr(null);
            const r = await act("revalue", {
              action: "revalue", code: form.code.trim(), on: form.on,
              fairValueMinor: v.toString(), basis: form.basis.trim() || undefined,
            });
            if (r) setMsg(String(r.note));
          }}>
          {busy === "revalue" ? "Posting…" : "Record the valuation"}
        </button>
        <p className="sw-sub mt-2 max-w-[70ch]">
          There is no separate button for an impairment. Whether this is a revaluation, an impairment or a reversal
          is what the same act is called afterwards — the split follows from the value and from what has happened to
          this asset before, and the result says which it turned out to be and why.
        </p>
      </Panel>

      {loading && !data && <Loading />}

      {data && rec && (
        <>
          <Panel className="mb-4 p-4">
            <div className="sw-label">Register against the ledger</div>
            <table className="sw-table mt-3" style={{ maxWidth: "44rem" }}>
              <caption className="sr-only">The revaluation surplus per the register against account 3300</caption>
              <thead>
                <tr>
                  <th />
                  <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Register</th>
                  <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Ledger</th>
                  <th style={{ width: "7rem" }} />
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row" style={{ textAlign: "start", fontWeight: 400 }}>
                    Revaluation surplus <span className="sw-code sw-sub">3300</span>
                  </th>
                  <td className="sw-num"><Figure minor={rec.registerSurplusMinor} colour={false} /></td>
                  <td className="sw-num"><Figure minor={rec.ledgerSurplusMinor} colour={false} /></td>
                  <td>
                    {rec.agrees
                      ? <span className="sw-chip sw-chip-ok">agrees</span>
                      : <span className="sw-chip sw-chip-bad">differs</span>}
                  </td>
                </tr>
                <tr>
                  <th scope="row" style={{ textAlign: "start", fontWeight: 400 }}>
                    Impairment charged, cumulative <span className="sw-code sw-sub">6650</span>
                  </th>
                  <td className="sw-num"><Figure minor={data.totals.impairedMinor} colour={false} /></td>
                  <td className="sw-num"><Figure minor={rec.ledgerImpairmentMinor} colour={false} /></td>
                  <td><span className="sw-sub">not compared</span></td>
                </tr>
              </tbody>
            </table>
            {rec.agrees ? (
              <p className="sw-sub mt-2 max-w-[70ch]">
                Every dirham of surplus in equity is accounted for by an asset that carries it. The impairment account
                is cumulative and includes reversals, so it is shown rather than compared.
              </p>
            ) : (
              <p className="sw-sub mt-2 max-w-[70ch]" style={{ color: "var(--sw-neg)" }} data-testid="revaluation-differs">
                The surplus in equity and the surplus the assets carry disagree. That is a finding: either 3300 was
                posted to by hand, or an asset was disposed of without its surplus being realised.
              </p>
            )}
          </Panel>

          {data.assets.length === 0 ? (
            <Empty>No asset has been revalued or impaired yet.</Empty>
          ) : (
            <Panel className="overflow-hidden">
              <div className="sw-scroll">
                <table className="sw-table">
                  <caption className="sr-only">Assets carrying a revaluation surplus or an impairment</caption>
                  <thead>
                    <tr>
                      <th style={{ width: "7rem" }}>Code</th>
                      <th>Asset</th>
                      <th style={{ width: "6rem" }}>Status</th>
                      <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Carried at</th>
                      <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Surplus</th>
                      <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Impaired</th>
                      <th style={{ width: "9rem" }} />
                    </tr>
                  </thead>
                  <tbody data-testid="revaluation-rows">
                    {data.assets.map((a) => (
                      <React.Fragment key={a.code}>
                        <tr>
                          <td className="sw-code">{a.code}</td>
                          <td className="max-w-0 truncate">{a.name}</td>
                          <td><StatusChip status={a.status} /></td>
                          <td className="sw-num"><Figure minor={a.carryingMinor} colour={false} /></td>
                          <td className="sw-num"><Figure minor={a.surplusMinor} colour={false} zero="dash" /></td>
                          <td className="sw-num"><Figure minor={a.impairedMinor} colour={false} zero="dash" /></td>
                          <td>
                            <button type="button" className="sw-link-btn"
                              aria-expanded={openCode === a.code}
                              onClick={() => setOpenCode(openCode === a.code ? null : a.code)}>
                              {openCode === a.code ? "Hide" : `${a.events.length} event${a.events.length === 1 ? "" : "s"}`}
                            </button>
                            {BigInt(a.surplusMinor) > 0n && (
                              <>
                                {" "}
                                <button type="button" className="sw-link-btn"
                                  disabled={busy === `release:${a.code}`}
                                  onClick={async () => {
                                    const r = await act(`release:${a.code}`, {
                                      action: "release", code: a.code, on: today(),
                                    });
                                    if (r) setMsg(String(r.note));
                                  }}>
                                  realise
                                </button>
                              </>
                            )}
                          </td>
                        </tr>
                        {openCode === a.code && (
                          <tr>
                            <td colSpan={7} style={{ background: "var(--sw-ground)" }}>
                              <table className="sw-table" style={{ maxWidth: "62rem", margin: "0.5rem" }}>
                                <caption className="sr-only">Every valuation of {a.code}, and how each was split</caption>
                                <thead>
                                  <tr>
                                    <th style={{ width: "3rem" }}>#</th>
                                    <th style={{ width: "7rem" }}>On</th>
                                    <th style={{ width: "7rem" }}>Turned out</th>
                                    <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>From</th>
                                    <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>To</th>
                                    <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>To equity</th>
                                    <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>To profit</th>
                                    <th>Basis</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {a.events.map((e) => (
                                    <tr key={e.seq}>
                                      <td className="sw-num">{e.seq}</td>
                                      <td>{e.on}</td>
                                      <td><span className="sw-chip">{KIND_WORD[e.kind] ?? e.kind}</span></td>
                                      <td className="sw-num"><Figure minor={e.carryingBeforeMinor} colour={false} /></td>
                                      <td className="sw-num"><Figure minor={e.fairValueMinor} colour={false} /></td>
                                      <td className="sw-num"><Figure minor={e.toSurplusMinor} zero="dash" /></td>
                                      <td className="sw-num"><Figure minor={e.toProfitMinor} zero="dash" /></td>
                                      <td className="sw-sub max-w-0 truncate">{e.basis ?? "—"}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                              <p className="sw-sub mx-2 mb-2 max-w-[70ch]">
                                The two split columns always add to the movement between the carrying amount and the
                                valuation. That is the whole of IAS 16.39–40, and it is shown per event so it can be
                                checked rather than taken on trust.
                              </p>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          )}

          <p className="sw-sub mt-3 max-w-[75ch]">
            A revaluation restates the cost and clears the accumulated depreciation against it, so depreciation from
            then on falls on the revalued amount over the life that is left. Realising a surplus moves it to retained
            earnings; equity is unchanged in total, and it only says how much of it is realised.
          </p>
        </>
      )}
    </>
  );
}
