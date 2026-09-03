import Link from "next/link";
import { prisma } from "@/lib/server/prisma";
import { getSession } from "@/lib/server/session";
import { listRecords } from "@/lib/server/store";
import { LedgerError } from "@/lib/server/ledger/post";
import { auditTrail, provenanceSummary, integrityCheck, ACTOR_TYPES, type AuditEntry } from "@/lib/server/ledger/audit";
import { Figure, PageHead, Panel, ErrorNote, Empty, StatusChip } from "@/components/ledger/primitives";

/**
 * The audit trail.
 *
 * This screen is rendered on the server and filtered through the URL rather
 * than through client state, which is unusual here and deliberate: a finding
 * has to be quotable. "The four unattributed entries in March" is only useful
 * to somebody else if the link they are sent reproduces exactly what was seen,
 * and an auditor's filter belongs in the address bar for the same reason a
 * working paper carries its own selection criteria.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface EntityRecord {
  id: string;
  legalNameEn?: string;
}

type Search = Record<string, string | string[] | undefined>;
const one = (s: Search, k: string) => {
  const v = s[k];
  const raw = (Array.isArray(v) ? v[0] : v) ?? "";
  return raw.trim();
};

const DAY = new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
const day = (d: Date) => DAY.format(d);

/**
 * Machine-posted entries are marked twice over: the chip carries the word
 * "auto" and the actor's name, and only then a colour. Colour is never the sole
 * signal in this codebase — a printed audit pack is black and white, and the
 * reader who most needs to spot an automated posting may be the one who cannot
 * tell the accent from the ink.
 */
function ActorChips({ e }: { e: AuditEntry }) {
  const label = e.actorType.toLowerCase();
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <span
        className={`sw-chip ${e.machinePosted ? "sw-chip-accent" : ""}`}
        title={e.machinePosted ? "Posted by software, without a person in the loop" : "Posted by a person"}
      >
        {e.machinePosted ? `${label} · auto` : label}
      </span>
      {e.actorId ? (
        <span className="sw-code" style={{ color: "var(--sw-fg-muted)" }}>{e.actorId}</span>
      ) : (
        <span className="sw-chip sw-chip-warn" title="Nothing identifies who or what posted this">
          unattributed
        </span>
      )}
    </span>
  );
}

export default async function AuditTrailPage({ searchParams }: { searchParams: Promise<Search> }) {
  const session = await getSession();
  if (!session) return <Empty>Sign in to read the audit trail.</Empty>;
  const { orgId, userId } = session;

  const sp = await searchParams;

  // The entity: whatever the URL says, else whichever one the user last chose
  // in the app, else the first this organisation has. A screen that quietly
  // shows a different entity's history than the one on screen elsewhere would
  // be worse than one that shows none.
  const entities = await listRecords<EntityRecord>(orgId, "entities");
  const chosen = await prisma.userMeta
    .findUnique({ where: { userId_key: { userId, key: "currentEntityId" } } })
    .then((r) => (r ? (JSON.parse(r.data) as string | undefined) : undefined))
    .catch(() => undefined);
  const entityId = one(sp, "entityId") || (chosen && entities.some((e) => e.id === chosen) ? chosen : entities[0]?.id) || "";

  const from = one(sp, "from");
  const to = one(sp, "to");
  const actorType = one(sp, "actorType");
  const source = one(sp, "source");
  const limit = Number(one(sp, "limit") || 100) || 100;

  const filters = (
    <Panel className="mb-4 p-3">
      <form method="get" className="flex flex-wrap items-end gap-3">
        <label className="grid gap-1">
          <span className="sw-label">Entity</span>
          <select name="entityId" defaultValue={entityId} className="sw-select" style={{ width: "14rem" }}>
            {entities.length === 0 && <option value="">No entities</option>}
            {entities.map((e) => (
              <option key={e.id} value={e.id}>{e.legalNameEn ?? e.id}</option>
            ))}
          </select>
        </label>
        <label className="grid gap-1">
          <span className="sw-label">From</span>
          <input type="date" name="from" defaultValue={from} className="sw-input" style={{ width: "9.5rem" }} />
        </label>
        <label className="grid gap-1">
          <span className="sw-label">To</span>
          <input type="date" name="to" defaultValue={to} className="sw-input" style={{ width: "9.5rem" }} />
        </label>
        <label className="grid gap-1">
          <span className="sw-label">Posted by</span>
          <select name="actorType" defaultValue={actorType} className="sw-select" style={{ width: "9rem" }}>
            <option value="">Anyone</option>
            {ACTOR_TYPES.map((a) => (
              <option key={a} value={a}>{a.toLowerCase()}</option>
            ))}
          </select>
        </label>
        <label className="grid gap-1">
          <span className="sw-label">Source</span>
          <input
            type="text" name="source" defaultValue={source} placeholder="invoice, bank, payroll…"
            className="sw-input" style={{ width: "10rem" }}
          />
        </label>
        <input type="hidden" name="limit" value={String(limit)} />
        <button type="submit" className="sw-btn sw-btn-primary" data-testid="apply-filters">Apply</button>
        <Link href="/accounting/audit" className="sw-link text-[0.8125rem]">Clear</Link>
      </form>
    </Panel>
  );

  const head = (
    <PageHead
      title="Audit trail"
      sub="Who or what posted every entry, what it came from, and what it did to the documents around it. Provenance is captured on the entry itself at the moment it is posted — this is that record, read back in the order the questions get asked."
    />
  );

  if (!entityId) {
    return (
      <>
        {head}
        <Empty>There is no entity to audit yet.</Empty>
      </>
    );
  }

  let entries: AuditEntry[] = [];
  let summary: Awaited<ReturnType<typeof provenanceSummary>> | null = null;
  let integrity: Awaited<ReturnType<typeof integrityCheck>> | null = null;
  let error: string | null = null;

  try {
    [entries, summary, integrity] = await Promise.all([
      auditTrail({ orgId, entityId, from: from || undefined, to: to || undefined, actorType: actorType || undefined, source: source || undefined, limit }),
      provenanceSummary({ orgId, entityId, from: from || undefined, to: to || undefined }),
      integrityCheck({ orgId, entityId }),
    ]);
  } catch (e) {
    error = e instanceof LedgerError ? e.message : "The audit trail could not be read.";
  }

  // A reversal link is only a link when its counterpart is on this page; when
  // the filter has excluded it, saying so is more honest than an anchor that
  // silently goes nowhere.
  const onPage = new Set(entries.map((e) => e.id));

  return (
    <>
      {head}
      {filters}
      {error && <ErrorNote>{error}</ErrorNote>}

      {summary && (
        <section className="sw-panel mb-4 p-3" data-testid="provenance-summary">
          <h2 className="sw-label mb-2">Provenance</h2>
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <div className="sw-sub">Entries in range</div>
              <div className="sw-num" style={{ fontSize: "1.25rem" }} data-testid="provenance-total">{summary.total}</div>
            </div>
            <div>
              <div className="sw-sub">By who or what</div>
              <div className="mt-1 flex flex-wrap gap-1" data-testid="by-actor-type">
                {summary.byActorType.length === 0 && <span className="sw-zero">–</span>}
                {summary.byActorType.map((a) => (
                  <span key={a.actorType} className={`sw-chip ${a.machine ? "sw-chip-accent" : ""}`}>
                    {a.actorType.toLowerCase()}{a.machine ? " · auto" : ""} {a.count}
                  </span>
                ))}
              </div>
            </div>
            <div>
              <div className="sw-sub">By source</div>
              <div className="mt-1 flex flex-wrap gap-1" data-testid="by-source">
                {summary.bySource.length === 0 && <span className="sw-zero">–</span>}
                {summary.bySource.map((s) => (
                  <span key={s.source} className="sw-chip">{s.source} {s.count}</span>
                ))}
              </div>
            </div>
          </div>
          <p className="sw-sub mt-3" data-testid="unattributed">
            {summary.unattributed === 0 ? (
              <>Every entry names the person, rule or integration behind it.</>
            ) : (
              <>
                <strong>{summary.unattributed}</strong> of {summary.total} entries have no actor recorded at all.
                A rule or an integration posting on its own is normal — an entry nobody can be traced to is not,
                because there is nobody to ask why it exists.
              </>
            )}
          </p>
        </section>
      )}

      {integrity && (
        <section className="sw-panel mb-4 p-3" data-testid="integrity-check">
          <h2 className="sw-label mb-2">Integrity check</h2>
          <p className="sw-sub" data-testid="integrity-verdict">
            {integrity.ok ? (
              <>
                Re-checked {integrity.checked} of {integrity.population} posted entries: every one still sums to zero in
                its functional currency. The database enforces this with a deferred constraint trigger, so nothing was
                expected here — a control that is never tested is a control nobody trusts.
              </>
            ) : (
              <>
                {integrity.failures.length} of {integrity.checked} entries checked do not balance. The database is
                supposed to make this impossible, so this is a defect in the guard itself and not something to correct
                by posting an adjustment.
              </>
            )}
          </p>
          {integrity.failures.length > 0 && (
            <ul className="mt-2 grid gap-1" data-testid="integrity-failures">
              {integrity.failures.map((f) => (
                <li key={f.id} className="sw-sub" style={{ color: "var(--sw-neg)" }}>{f.reason}</li>
              ))}
            </ul>
          )}
        </section>
      )}

      {!error && entries.length === 0 && <Empty>No entries match these filters.</Empty>}

      {entries.length > 0 && (
        <Panel className="overflow-hidden">
          <div className="sw-scroll">
            <table className="sw-table">
              <caption className="sr-only">Posted entries with their provenance, newest first</caption>
              <thead>
                <tr>
                  <th style={{ width: "8rem" }}>Reference</th>
                  <th style={{ width: "7.5rem" }}>Date</th>
                  <th style={{ width: "13rem" }}>Posted by</th>
                  <th className="hidden md:table-cell" style={{ width: "10rem" }}>Source</th>
                  <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Amount</th>
                  <th style={{ width: "5rem" }}>Docs</th>
                  <th style={{ width: "6rem" }}>Status</th>
                  <th>What happened</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.id} id={`entry-${e.id}`} data-testid={`entry-${e.reference}`} data-machine={e.machinePosted ? "true" : "false"}>
                    <td className="sw-code">{e.reference}</td>
                    <td>{day(e.entryDate)}</td>
                    <td><ActorChips e={e} /></td>
                    <td className="hidden md:table-cell" style={{ color: "var(--sw-fg-muted)" }}>
                      {e.source}
                      {e.sourceType && (
                        <div className="sw-code" style={{ fontSize: "0.6875rem" }}>
                          {e.sourceType.toLowerCase().replace(/_/g, " ")} {e.sourceId ?? ""}
                        </div>
                      )}
                    </td>
                    <td className="sw-num">
                      <Figure minor={e.amountMinor.toString()} currency={e.currency} colour={false} />
                    </td>
                    <td>
                      {e.attachments === 0 ? (
                        <span className="sw-zero">–</span>
                      ) : (
                        <span className="sw-chip" title={`${e.attachments} document(s) attached`}>{e.attachments}</span>
                      )}
                    </td>
                    <td><StatusChip status={e.status} /></td>
                    <td>
                      {e.story}
                      {(e.reversedBy || e.reversalOf) && (
                        <div className="mt-0.5">
                          {e.reversedBy && (
                            <ReversalLink label="Reversed by" ref_={e.reversedBy} onPage={onPage} />
                          )}
                          {e.reversalOf && (
                            <ReversalLink label="Reverses" ref_={e.reversalOf} onPage={onPage} />
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="sw-sub px-3 py-2" style={{ borderTop: "1px solid var(--sw-line)" }}>
            Showing {entries.length} {entries.length === 1 ? "entry" : "entries"}
            {entries.length === limit ? " — the page limit, so there may be more" : ""}. A posted entry is never edited,
            so everything here is what was recorded at the time.
          </p>
        </Panel>
      )}
    </>
  );
}

function ReversalLink({
  label, ref_, onPage,
}: {
  label: string;
  ref_: { id: string; reference: string; entryDate: Date };
  onPage: Set<string>;
}) {
  return (
    <span className="sw-sub me-3">
      {label}{" "}
      {onPage.has(ref_.id) ? (
        <a href={`#entry-${ref_.id}`} className="sw-link sw-code">{ref_.reference}</a>
      ) : (
        <span className="sw-code" title="Outside the current filter — widen the dates to see it">
          {ref_.reference}
        </span>
      )}{" "}
      <span className="sw-zero">{day(ref_.entryDate)}</span>
    </span>
  );
}
