"use client";

import * as React from "react";
import { api, ApiError, useEntityId, useLedgerQuery } from "@/components/ledger/use-ledger";
import { Figure, PageHead, Panel, ErrorNote, Loading, Empty } from "@/components/ledger/primitives";
import { parseAmount } from "@/lib/ledger/format";

interface Party {
  id: string; partyKey: string; name: string;
  relationship: string; relationshipLabel: string;
  startedOn: string; endedOn: string | null;
  declaredBy: string; declaredOn: string;
  salesMinor: string; purchasesMinor: string; documents: number;
  notes: string | null;
}
interface Note {
  period: string; from: string; to: string;
  parties: Party[];
  byRelationship: { relationship: string; label: string; count: number; salesMinor: string; purchasesMinor: string }[];
  compensation: {
    rows: { category: string; label: string; amountMinor: string; headcount: number; declaredBy: string }[];
    totalMinor: string;
    missingCategories: { category: string; label: string }[];
    headcount: number | null;
  };
  attestation: {
    present: boolean; parentName: string | null; ultimateControllingParty: string | null;
    noControllingParty: boolean; attestedBy: string | null; attestedOn: string | null;
  };
  completeness: { unassessed: string[]; unassessedCount: number; complete: boolean; reasons: string[] };
  basis: string;
  relationships: Record<string, string>;
  categories: Record<string, string>;
}

const thisYear = () => String(new Date().getUTCFullYear());

export default function RelatedPartiesPage() {
  const entityId = useEntityId();
  const [period, setPeriod] = React.useState(thisYear);
  const { data, error, loading, reload } = useLedgerQuery<Note>(
    entityId ? `/api/ledger/related-parties?entityId=${entityId}&period=${period}` : null,
    [period],
  );

  const [busy, setBusy] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [adding, setAdding] = React.useState(false);

  const act = async (label: string, body: Record<string, unknown>) => {
    setBusy(label); setErr(null); setMsg(null);
    try {
      const r = await api<Record<string, unknown>>("/api/ledger/related-parties", {
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

  return (
    <>
      <PageHead
        title="Related parties"
        sub={
          "A ledger cannot know which parties are related. Relatedness is a fact about people and control — a " +
          "director's spouse, an entity under common control — and none of it is written in a chart of accounts. " +
          "So everything here is declared, and every declaration names who made it. A detector would produce a " +
          "confident, incomplete list, and a reader would take its silence about everybody else as a statement."
        }
        actions={
          <label className="flex items-center gap-1.5">
            <span className="sw-label">Period</span>
            <input className="sw-input sw-num" style={{ width: "7rem" }} value={period}
              onChange={(e) => setPeriod(e.target.value)} aria-label="Reporting period" />
          </label>
        }
      />

      {err && <ErrorNote>{err}</ErrorNote>}
      {msg && <div className="sw-note mb-3" role="status" data-testid="rp-result">{msg}</div>}
      {error && <ErrorNote>{error}</ErrorNote>}
      {loading && !data && <Loading />}

      {data && (
        <>
          <Panel className="mb-4 p-4">
            <div className="sw-label">Is the note complete?</div>
            <div className="mt-2" role="status" data-testid="rp-complete">
              {data.completeness.complete
                ? <span className="sw-chip">yes — everybody assessed, every category answered, attested</span>
                : <span className="sw-chip sw-chip-bad">not yet</span>}
            </div>
            {data.completeness.reasons.length > 0 && (
              <ul className="mt-3 space-y-1" data-testid="rp-reasons">
                {data.completeness.reasons.map((r) => (
                  <li key={r} className="sw-sub" style={{ color: "var(--sw-warn)" }}>{r}</li>
                ))}
              </ul>
            )}
            <p className="sw-sub mt-3 max-w-[75ch]">
              A note that is empty because somebody assessed the counterparties and found nothing is a different
              document from one that is empty because nobody was asked. A reader cannot tell them apart, so the
              software insists on the difference. Basis: {data.basis}.
            </p>
          </Panel>

          <Panel className="mb-4 p-4">
            <div className="sw-label">Control — IAS 24.13</div>
            <p className="sw-sub mt-1 max-w-[75ch]">
              Required whether or not anything passed between them, which is why a nil balance does not excuse it.
            </p>
            {data.attestation.present ? (
              <dl className="mt-3 grid gap-4 sm:grid-cols-3">
                <div>
                  <dt className="sw-label">Parent</dt>
                  <dd className="mt-1">{data.attestation.parentName ?? "—"}</dd>
                </div>
                <div>
                  <dt className="sw-label">Ultimate controlling party</dt>
                  <dd className="mt-1">
                    {data.attestation.noControllingParty
                      ? "None — stated, not assumed"
                      : data.attestation.ultimateControllingParty ?? "—"}
                  </dd>
                </div>
                <div>
                  <dt className="sw-label">Attested</dt>
                  <dd className="mt-1 sw-sub">
                    {data.attestation.attestedBy} on {data.attestation.attestedOn}
                  </dd>
                </div>
              </dl>
            ) : (
              <Attest
                busy={busy === "attest"}
                onAttest={async (body) => {
                  const r = await act("attest", { action: "attest", period, ...body });
                  if (r) setMsg(`Attested for ${period}.`);
                }}
              />
            )}
          </Panel>

          <div className="mb-3 flex items-center justify-between">
            <div className="sw-label">
              Parties declared related for {data.from} to {data.to}
            </div>
            <button type="button" className="sw-btn" onClick={() => setAdding((a) => !a)} data-testid="toggle-declare">
              {adding ? "Cancel" : "Declare a party"}
            </button>
          </div>

          {adding && (
            <Declare
              relationships={data.relationships}
              busy={busy === "declare"}
              onDeclare={async (party) => {
                const r = await act("declare", { action: "declare", party });
                if (r) { setAdding(false); setMsg(`${party.partyKey} declared ${data.relationships[party.relationship]?.toLowerCase()}.`); }
              }}
            />
          )}

          {data.parties.length === 0 ? (
            <Empty>Nobody has been declared related for this period.</Empty>
          ) : (
            <Panel className="mb-4 overflow-hidden">
              <div className="sw-scroll">
                <table className="sw-table">
                  <caption className="sr-only">Declared related parties and what passed between them</caption>
                  <thead>
                    <tr>
                      <th>Party</th>
                      <th style={{ width: "16rem" }}>Relationship</th>
                      <th style={{ width: "12rem" }}>Related from</th>
                      <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Sales</th>
                      <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Purchases</th>
                      <th className="sw-num" style={{ width: "5rem" }}>Docs</th>
                      <th style={{ width: "6rem" }} />
                    </tr>
                  </thead>
                  <tbody data-testid="rp-rows">
                    {data.parties.map((p) => (
                      <tr key={p.id}>
                        <td className="max-w-0 truncate">
                          {p.name}
                          {p.notes && <span className="sw-sub"> — {p.notes}</span>}
                        </td>
                        <td>{p.relationshipLabel}</td>
                        <td className="sw-sub">
                          {p.startedOn} to {p.endedOn ?? "further notice"}
                          <div>declared by {p.declaredBy}, {p.declaredOn}</div>
                        </td>
                        <td className="sw-num"><Figure minor={p.salesMinor} colour={false} /></td>
                        <td className="sw-num"><Figure minor={p.purchasesMinor} colour={false} /></td>
                        <td className="sw-num">{p.documents}</td>
                        <td>
                          {!p.endedOn && (
                            <button type="button" className="sw-link-btn" disabled={busy === `end:${p.id}`}
                              onClick={async () => {
                                const on = window.prompt("From what date did the relationship end?", data.to);
                                if (!on) return;
                                const r = await act(`end:${p.id}`, { action: "end", id: p.id, endedOn: on });
                                if (r) setMsg(`${p.name} is related until ${on}. Earlier periods keep the disclosure.`);
                              }}>
                              ended
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    {data.byRelationship.map((g) => (
                      <tr key={g.relationship}>
                        <th scope="row" className="sw-sub">{g.label}</th>
                        <th className="sw-sub">{g.count}</th>
                        <th />
                        <th className="sw-num"><Figure minor={g.salesMinor} colour={false} /></th>
                        <th className="sw-num"><Figure minor={g.purchasesMinor} colour={false} /></th>
                        <th />
                        <th />
                      </tr>
                    ))}
                  </tfoot>
                </table>
              </div>
            </Panel>
          )}

          <Panel className="mb-4 p-4">
            <div className="sw-label">Key management compensation — IAS 24.17</div>
            <p className="sw-sub mt-1 max-w-[75ch]">
              In total <em>and</em> by each of the five categories the standard names. A business that discloses only
              a total has not made the disclosure. It is required even where the only key management personnel is the
              owner.
            </p>

            <table className="sw-table mt-3" style={{ maxWidth: "44rem" }}>
              <caption className="sr-only">Key management compensation by category</caption>
              <thead>
                <tr>
                  <th>Category</th>
                  <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Amount</th>
                  <th className="sw-num" style={{ width: "6rem" }}>People</th>
                </tr>
              </thead>
              <tbody data-testid="rp-comp-rows">
                {data.compensation.rows.map((r) => (
                  <tr key={r.category}>
                    <td>{r.label}</td>
                    <td className="sw-num"><Figure minor={r.amountMinor} colour={false} /></td>
                    <td className="sw-num">{r.headcount || "—"}</td>
                  </tr>
                ))}
                {data.compensation.missingCategories.map((m) => (
                  <tr key={m.category} style={{ opacity: 0.6 }}>
                    <td>{m.label}</td>
                    <td className="sw-num sw-sub">not answered</td>
                    <td className="sw-num sw-sub">—</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row">Total</th>
                  <th className="sw-num" data-testid="rp-comp-total">
                    <Figure minor={data.compensation.totalMinor} colour={false} />
                  </th>
                  <th className="sw-num">
                    {data.compensation.headcount ?? <span className="sw-sub">varies</span>}
                  </th>
                </tr>
              </tfoot>
            </table>
            {data.compensation.headcount === null && data.compensation.rows.length > 1 && (
              <p className="sw-sub mt-2 max-w-[75ch]">
                The declarations disagree about how many people the figures cover, so no single headcount is shown.
                Picking one would be a number a reader could not check.
              </p>
            )}

            <Compensation
              categories={data.categories}
              busy={busy === "compensation"}
              onDeclare={async (body) => {
                const r = await act("compensation", { action: "compensation", period, ...body });
                if (r) setMsg(`Recorded ${data.categories[body.category]?.toLowerCase()} for ${period}.`);
              }}
            />
          </Panel>

          {data.completeness.unassessedCount > 0 && (
            <Panel className="p-4">
              <div className="sw-label">
                Never assessed — {data.completeness.unassessedCount}
              </div>
              <p className="sw-sub mt-1 max-w-[75ch]">
                Counterparties the entity trades with that have been neither declared related nor declared unrelated.
                The note cannot claim to be complete while anybody here is unaccounted for.
              </p>
              <ul className="mt-2 grid gap-1 sm:grid-cols-3" data-testid="rp-unassessed">
                {data.completeness.unassessed.map((u) => (
                  <li key={u} className="sw-sub">{u}</li>
                ))}
              </ul>
            </Panel>
          )}
        </>
      )}
    </>
  );
}

function Declare({ relationships, busy, onDeclare }: {
  relationships: Record<string, string>;
  busy: boolean;
  onDeclare: (p: {
    partyKey: string; relationship: string; declaredBy: string;
    startedOn: string; endedOn?: string; notes?: string;
  }) => void;
}) {
  const [partyKey, setPartyKey] = React.useState("");
  const [relationship, setRelationship] = React.useState("KEY_MANAGEMENT");
  const [declaredBy, setDeclaredBy] = React.useState("");
  const [startedOn, setStartedOn] = React.useState(() => `${new Date().getUTCFullYear()}-01-01`);
  const [endedOn, setEndedOn] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [err, setErr] = React.useState<string | null>(null);

  return (
    <Panel className="mb-4 p-4">
      <div className="sw-label">Declare a party related</div>
      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <label className="block">
          <span className="sw-label">Party</span>
          <input className="sw-input mt-1" value={partyKey} onChange={(e) => setPartyKey(e.target.value)}
            placeholder="customer code or name" />
        </label>
        <label className="block">
          <span className="sw-label">Relationship</span>
          <select className="sw-select mt-1" value={relationship} onChange={(e) => setRelationship(e.target.value)}>
            {Object.entries(relationships).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="sw-label">Declared by</span>
          <input className="sw-input mt-1" value={declaredBy} onChange={(e) => setDeclaredBy(e.target.value)}
            placeholder="who is asserting this" />
        </label>
        <label className="block">
          <span className="sw-label">Related from</span>
          <input type="date" className="sw-input mt-1" value={startedOn} onChange={(e) => setStartedOn(e.target.value)} />
        </label>
        <label className="block">
          <span className="sw-label">Until</span>
          <input type="date" className="sw-input mt-1" value={endedOn} onChange={(e) => setEndedOn(e.target.value)} />
        </label>
        <label className="block">
          <span className="sw-label">Note</span>
          <input className="sw-input mt-1" value={notes} onChange={(e) => setNotes(e.target.value)}
            placeholder="optional" />
        </label>
      </div>

      {err && <div className="sw-error mt-2" role="alert">{err}</div>}

      <div className="mt-3">
        <button type="button" className="sw-btn sw-btn-primary" disabled={busy} data-testid="save-declaration"
          onClick={() => {
            if (!partyKey.trim()) { setErr("Which party?"); return; }
            if (!declaredBy.trim()) { setErr("A declaration nobody owns is not a declaration. Say who is asserting it."); return; }
            setErr(null);
            onDeclare({
              partyKey: partyKey.trim(), relationship, declaredBy: declaredBy.trim(),
              startedOn, endedOn: endedOn || undefined, notes: notes.trim() || undefined,
            });
          }}>
          {busy ? "Recording…" : "Record the declaration"}
        </button>
      </div>
    </Panel>
  );
}

function Compensation({ categories, busy, onDeclare }: {
  categories: Record<string, string>;
  busy: boolean;
  onDeclare: (b: { category: string; amountMinor: string; headcount: number; declaredBy: string }) => void;
}) {
  const [category, setCategory] = React.useState("SHORT_TERM");
  const [amount, setAmount] = React.useState("");
  const [headcount, setHeadcount] = React.useState("");
  const [declaredBy, setDeclaredBy] = React.useState("");
  const [err, setErr] = React.useState<string | null>(null);

  return (
    <div className="mt-4">
      <div className="grid gap-3 sm:grid-cols-4">
        <label className="block">
          <span className="sw-label">Category</span>
          <select className="sw-select mt-1" value={category} onChange={(e) => setCategory(e.target.value)}>
            {Object.entries(categories).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="sw-label">Amount</span>
          <input className="sw-input sw-num mt-1" value={amount} placeholder="0.00"
            onChange={(e) => setAmount(e.target.value)} />
        </label>
        <label className="block">
          <span className="sw-label">People covered</span>
          <input className="sw-input sw-num mt-1" value={headcount} onChange={(e) => setHeadcount(e.target.value)} />
        </label>
        <label className="block">
          <span className="sw-label">Declared by</span>
          <input className="sw-input mt-1" value={declaredBy} onChange={(e) => setDeclaredBy(e.target.value)} />
        </label>
      </div>

      {err && <div className="sw-error mt-2" role="alert">{err}</div>}

      <button type="button" className="sw-btn sw-btn-sm mt-3" disabled={busy} data-testid="save-compensation"
        onClick={() => {
          const a = parseAmount(amount || "0", "AED");
          const h = Number(headcount);
          if (a === null || a < 0n) { setErr("That is not an amount I can read."); return; }
          if (!Number.isInteger(h) || h < 0) { setErr("How many people does the figure cover?"); return; }
          if (a > 0n && h === 0) { setErr("Nought people cannot be paid anything."); return; }
          if (!declaredBy.trim()) { setErr("Say who is asserting these figures."); return; }
          setErr(null);
          onDeclare({ category, amountMinor: a.toString(), headcount: h, declaredBy: declaredBy.trim() });
        }}>
        {busy ? "Recording…" : "Record the category"}
      </button>
    </div>
  );
}

function Attest({ busy, onAttest }: {
  busy: boolean;
  onAttest: (b: {
    attestedBy: string; parentName?: string; ultimateControllingParty?: string; noControllingParty?: boolean;
  }) => void;
}) {
  const [attestedBy, setAttestedBy] = React.useState("");
  const [parentName, setParentName] = React.useState("");
  const [ultimate, setUltimate] = React.useState("");
  const [none, setNone] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  return (
    <div className="mt-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="block">
          <span className="sw-label">Parent</span>
          <input className="sw-input mt-1" value={parentName} disabled={none}
            onChange={(e) => setParentName(e.target.value)} />
        </label>
        <label className="block">
          <span className="sw-label">Ultimate controlling party</span>
          <input className="sw-input mt-1" value={ultimate} disabled={none}
            onChange={(e) => setUltimate(e.target.value)} />
        </label>
        <label className="block">
          <span className="sw-label">Attested by</span>
          <input className="sw-input mt-1" value={attestedBy} onChange={(e) => setAttestedBy(e.target.value)} />
        </label>
      </div>

      <label className="mt-3 flex items-center gap-2">
        <input type="checkbox" className="sw-check" checked={none}
          onChange={(e) => { setNone(e.target.checked); if (e.target.checked) { setParentName(""); setUltimate(""); } }} />
        <span>There is no controlling party. This is a statement somebody makes, not something silence implies.</span>
      </label>

      {err && <div className="sw-error mt-2" role="alert">{err}</div>}

      <button type="button" className="sw-btn sw-btn-primary sw-btn-sm mt-3" disabled={busy} data-testid="save-attestation"
        onClick={() => {
          if (!attestedBy.trim()) { setErr("Who is making this attestation?"); return; }
          if (!none && !parentName.trim() && !ultimate.trim()) {
            setErr("Name a parent or an ultimate controlling party, or state that there is none.");
            return;
          }
          setErr(null);
          onAttest({
            attestedBy: attestedBy.trim(),
            parentName: parentName.trim() || undefined,
            ultimateControllingParty: ultimate.trim() || undefined,
            noControllingParty: none,
          });
        }}>
        {busy ? "Recording…" : "Attest"}
      </button>
    </div>
  );
}
