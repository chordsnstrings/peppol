"use client";

import * as React from "react";
import { api, useLedgerQuery } from "@/components/ledger/use-ledger";
import { Figure, PageHead, Panel, ErrorNote, Loading, Empty, StatusChip } from "@/components/ledger/primitives";

interface Line {
  code: string; name: string; nameAr: string | null;
  byEntity: Record<string, string>;
  combinedMinor: string; eliminationMinor: string; totalMinor: string;
}
interface Section {
  key: string; label: string; lines: Line[];
  byEntity: Record<string, string>;
  combinedMinor: string; eliminationMinor: string; totalMinor: string;
}
interface Elimination {
  receivableEntityId: string; payableEntityId: string;
  receivableCode: string; payableCode: string;
  amountMinor: string; reason: string; applied: boolean;
}
interface Nci {
  entityId: string; ownershipBps: number; minorityBps: number;
  memberNetAssetsMinor: string; memberProfitMinor: string;
  netAssetsMinor: string; profitMinor: string;
}
interface MemberColumn {
  entityId: string; ownershipBps: number; isParent: boolean; currency: string;
  netProfitMinor: string; totalAssetsMinor: string; netAssetsMinor: string;
  ownBalanceSheetBalanced: boolean;
}
interface Consolidated {
  groupCode: string; groupName: string; currency: string; from: string; to: string;
  members: MemberColumn[];
  revenue: Section; costOfSales: Section; grossProfitMinor: string; expenses: Section;
  netProfitMinor: string; profitAttributableToParentMinor: string; profitAttributableToNciMinor: string;
  assets: Section; liabilities: Section; equity: Section;
  equityAttributableToParentMinor: string; nonControllingInterestMinor: string; nci: Nci[];
  totalAssetsMinor: string; totalLiabilitiesEquityAndNciMinor: string;
  balanced: boolean; differenceMinor: string;
  eliminations: Elimination[]; eliminationsApplied: boolean; warnings: string[];
}
interface MemberDetail {
  entityId: string; ownershipBps: number; isParent: boolean;
  currency: string | null; hasLedger: boolean;
}
interface GroupDetail { code: string; name: string; currency: string; members: MemberDetail[] }
interface GroupSummary { code: string; name: string; currency: string; memberCount: number; parentEntityId: string | null }

function ytd() {
  const now = new Date();
  return { from: `${now.getUTCFullYear()}-01-01`, to: now.toISOString().slice(0, 10) };
}

/** The reader wants a percentage; the ledger keeps basis points. Both, exactly. */
const pct = (bps: number) => `${(bps / 100).toFixed(2)}%`;

export default function ConsolidationPage() {
  const [range, setRange] = React.useState(ytd);
  const [group, setGroup] = React.useState("");
  const [applyEliminations, setApplyEliminations] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const groups = useLedgerQuery<{ groups: GroupSummary[] }>("/api/ledger/consolidation");
  const list = groups.data?.groups ?? [];

  React.useEffect(() => {
    if (group || !list.length) return;
    setGroup(list[0].code);
  }, [list, group]);

  const q = useLedgerQuery<{ group: GroupDetail; consolidated: Consolidated }>(
    group
      ? `/api/ledger/consolidation?group=${encodeURIComponent(group)}&from=${range.from}&to=${range.to}` +
        `&applyEliminations=${applyEliminations ? "true" : "false"}`
      : null,
  );

  const c = q.data?.consolidated;
  const detail = q.data?.group;
  const order = c?.members.map((m) => m.entityId) ?? [];

  async function removeMember(entityId: string) {
    setErr(null); setMsg(null); setBusy(true);
    try {
      await api("/api/ledger/consolidation", {
        method: "POST",
        body: JSON.stringify({ action: "remove-member", group, entityId }),
      });
      setMsg(`${entityId} is no longer consolidated into ${group}.`);
      q.reload();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHead
        title="Consolidation"
        sub="One set of statements for the whole group, added line by line on account code. A subsidiary the group controls is consolidated in full whatever the ownership percentage, and the minority's share is shown as a non-controlling interest — control, not proportion, is what consolidation means."
        actions={
          <>
            <label className="flex items-center gap-1.5">
              <span className="sw-label">Group</span>
              <select className="sw-select" style={{ width: "12rem" }} value={group} data-testid="group-select"
                onChange={(e) => setGroup(e.target.value)}>
                {list.map((g) => <option key={g.code} value={g.code}>{g.name}</option>)}
              </select>
            </label>
            <label className="flex items-center gap-1.5">
              <span className="sw-label">From</span>
              <input type="date" className="sw-input" style={{ width: "9.5rem" }} value={range.from}
                onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))} />
            </label>
            <label className="flex items-center gap-1.5">
              <span className="sw-label">To</span>
              <input type="date" className="sw-input" style={{ width: "9.5rem" }} value={range.to}
                onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))} />
            </label>
          </>
        }
      />

      {groups.error && <ErrorNote>{groups.error}</ErrorNote>}
      {q.error && <ErrorNote>{q.error}</ErrorNote>}
      {err && <ErrorNote>{err}</ErrorNote>}
      {msg && <div className="sw-note" role="status">{msg}</div>}
      {(groups.loading || q.loading) && <Loading />}

      {!groups.loading && !groups.error && list.length === 0 && (
        <Empty>
          No consolidation groups have been set up yet. A group is a parent entity and the subsidiaries it controls;
          create one through the consolidation API and its statements will report here.
        </Empty>
      )}

      {c && detail && (
        <div className="grid gap-4">
          <Panel className="overflow-hidden">
            <Head>Members of {c.groupName}</Head>
            <div className="sw-scroll">
              <table className="sw-table">
                <caption className="sr-only">Members of {c.groupName}, their ownership and their contribution</caption>
                <thead>
                  <tr>
                    <th>Entity</th>
                    <th>Role</th>
                    <th className="sw-num" style={{ width: "7rem" }}>Owned</th>
                    <th style={{ width: "6rem" }}>Currency</th>
                    <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Net assets</th>
                    <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Profit</th>
                    <th style={{ width: "6rem" }} />
                  </tr>
                </thead>
                <tbody>
                  {c.members.map((m) => (
                    <tr key={m.entityId} data-testid="member-row">
                      <td className="sw-code">{m.entityId}</td>
                      <td>{m.isParent ? <StatusChip status="parent" /> : "Subsidiary"}</td>
                      <td className="sw-num">{pct(m.ownershipBps)}</td>
                      <td>
                        {m.currency}
                        {m.currency !== c.currency && (
                          <span className="sw-chip sw-chip-warn ms-1">not {c.currency}</span>
                        )}
                      </td>
                      <td className="sw-num"><Figure minor={m.netAssetsMinor} currency={m.currency} zero="zero" /></td>
                      <td className="sw-num"><Figure minor={m.netProfitMinor} currency={m.currency} zero="zero" /></td>
                      <td>
                        <button type="button" className="sw-btn" disabled={busy}
                          onClick={() => removeMember(m.entityId)}>Remove</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>

          {c.warnings.length > 0 && (
            <Panel className="overflow-hidden">
              <Head>Read these before using the figures</Head>
              <ul className="grid gap-2 px-3 py-2" data-testid="warnings">
                {c.warnings.map((w, i) => (
                  <li key={i} className="sw-sub" style={{ color: "var(--sw-warn)" }}>{w}</li>
                ))}
              </ul>
            </Panel>
          )}

          <Panel className="overflow-hidden">
            <Head>
              Intercompany balances — {c.eliminations.length} proposed
              {c.eliminationsApplied ? ", applied to the figures below" : ", not applied"}
            </Head>
            <div className="px-3 py-2">
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={applyEliminations} data-testid="apply-eliminations"
                  onChange={(e) => setApplyEliminations(e.target.checked)} />
                <span className="sw-sub">
                  Eliminate these balances from the group figures. Off by default: a journal line records no
                  counterparty, so a match on the control accounts is evidence, not proof. Read each one first.
                </span>
              </label>
            </div>
            {c.eliminations.length === 0 ? (
              <p className="sw-sub px-3 pb-3" data-testid="no-eliminations">
                No member&rsquo;s trade receivables match another member&rsquo;s trade payables, so nothing is
                proposed. That is not the same as there being nothing to eliminate.
              </p>
            ) : (
              <div className="sw-scroll">
                <table className="sw-table">
                  <caption className="sr-only">Proposed intercompany eliminations</caption>
                  <thead>
                    <tr>
                      <th>Receivable in</th>
                      <th>Payable in</th>
                      <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Amount</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {c.eliminations.map((e, i) => (
                      <tr key={i} data-testid="elimination-row">
                        <td className="sw-code">{e.receivableEntityId} · {e.receivableCode}</td>
                        <td className="sw-code">{e.payableEntityId} · {e.payableCode}</td>
                        <td className="sw-num"><Figure minor={e.amountMinor} currency={c.currency} /></td>
                        <td><StatusChip status={e.applied ? "applied" : "proposed"} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          <div className="grid gap-4 lg:grid-cols-2">
            <Panel className="overflow-hidden">
              <Head>Consolidated profit and loss, {c.from} to {c.to}</Head>
              <div className="sw-scroll">
                <table className="sw-table">
                  <caption className="sr-only">Consolidated profit and loss by member, {c.from} to {c.to}</caption>
                  <ColumnHead order={order} eliminated={c.eliminationsApplied} />
                  <Rows section={c.revenue} order={order} currency={c.currency} eliminated={c.eliminationsApplied} />
                  <Rows section={c.costOfSales} order={order} currency={c.currency} eliminated={c.eliminationsApplied} />
                  <Subtotal label="Gross profit" minor={c.grossProfitMinor} currency={c.currency}
                    span={order.length + (c.eliminationsApplied ? 3 : 2)} />
                  <Rows section={c.expenses} order={order} currency={c.currency} eliminated={c.eliminationsApplied} />
                  <tfoot>
                    <tr>
                      <th scope="row" colSpan={order.length + (c.eliminationsApplied ? 3 : 2)} style={{ textAlign: "end" }}>
                        Profit for the period
                      </th>
                      <td className="sw-num" data-testid="group-net-profit">
                        <Figure minor={c.netProfitMinor} currency={c.currency} zero="zero" />
                      </td>
                    </tr>
                    <tr>
                      <th scope="row" colSpan={order.length + (c.eliminationsApplied ? 3 : 2)} style={{ textAlign: "end", fontWeight: 400 }}>
                        <span className="sw-sub">Owners of the parent</span>
                      </th>
                      <td className="sw-num">
                        <Figure minor={c.profitAttributableToParentMinor} currency={c.currency} zero="zero" />
                      </td>
                    </tr>
                    <tr>
                      <th scope="row" colSpan={order.length + (c.eliminationsApplied ? 3 : 2)} style={{ textAlign: "end", fontWeight: 400 }}>
                        <span className="sw-sub">Non-controlling interest</span>
                      </th>
                      <td className="sw-num" data-testid="nci-profit">
                        <Figure minor={c.profitAttributableToNciMinor} currency={c.currency} zero="zero" />
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </Panel>

            <Panel className="overflow-hidden">
              <Head>Consolidated balance sheet as at {c.to}</Head>
              <div className="sw-scroll">
                <table className="sw-table">
                  <caption className="sr-only">Consolidated balance sheet by member as at {c.to}</caption>
                  <ColumnHead order={order} eliminated={c.eliminationsApplied} />
                  <Rows section={c.assets} order={order} currency={c.currency} eliminated={c.eliminationsApplied} />
                  <Subtotal label="Total assets" minor={c.totalAssetsMinor} currency={c.currency}
                    span={order.length + (c.eliminationsApplied ? 3 : 2)} testId="group-total-assets" />
                  <Rows section={c.liabilities} order={order} currency={c.currency} eliminated={c.eliminationsApplied} />
                  <Rows section={c.equity} order={order} currency={c.currency} eliminated={c.eliminationsApplied} />
                  <tfoot>
                    <tr>
                      <th scope="row" colSpan={order.length + (c.eliminationsApplied ? 3 : 2)} style={{ textAlign: "end", fontWeight: 400 }}>
                        <span className="sw-sub">Equity attributable to owners of the parent</span>
                      </th>
                      <td className="sw-num">
                        <Figure minor={c.equityAttributableToParentMinor} currency={c.currency} zero="zero" colour={false} />
                      </td>
                    </tr>
                    <tr>
                      <th scope="row" colSpan={order.length + (c.eliminationsApplied ? 3 : 2)} style={{ textAlign: "end", fontWeight: 400 }}>
                        <span className="sw-sub">Non-controlling interest</span>
                      </th>
                      <td className="sw-num" data-testid="nci-net-assets">
                        <Figure minor={c.nonControllingInterestMinor} currency={c.currency} zero="zero" colour={false} />
                      </td>
                    </tr>
                    <tr>
                      <th scope="row" colSpan={order.length + (c.eliminationsApplied ? 3 : 2)} style={{ textAlign: "end" }}>
                        Liabilities, equity and non-controlling interest
                      </th>
                      <td className="sw-num" data-testid="group-total-liab-eq">
                        <Figure minor={c.totalLiabilitiesEquityAndNciMinor} currency={c.currency} zero="zero" colour={false} />
                      </td>
                    </tr>
                    {!c.balanced && (
                      <tr>
                        <th scope="row" colSpan={order.length + (c.eliminationsApplied ? 3 : 2)}
                          style={{ textAlign: "end", color: "var(--sw-neg)" }}>Out of balance by</th>
                        <td className="sw-num sw-num-neg">
                          <Figure minor={c.differenceMinor} currency={c.currency} zero="zero" />
                        </td>
                      </tr>
                    )}
                  </tfoot>
                </table>
              </div>
              <p className="sw-sub px-3 py-2" style={{ borderTop: "1px solid var(--sw-line)" }} data-testid="group-bs-note">
                {c.balanced ? (
                  <>
                    Group assets equal group liabilities plus equity plus the non-controlling interest. The
                    non-controlling interest of{" "}
                    <Figure minor={c.nonControllingInterestMinor} currency={c.currency} zero="zero" /> is the minority&rsquo;s
                    share of net assets in the members it part-owns — those members are still consolidated in full,
                    because the group controls all of what they hold.
                  </>
                ) : (
                  <>
                    The group does not balance, by{" "}
                    <Figure minor={c.differenceMinor} currency={c.currency} zero="zero" />. Nothing here is plugged to
                    hide it. Check each member&rsquo;s own balance sheet first — a member that does not balance carries
                    its difference straight into the group.
                  </>
                )}
              </p>
            </Panel>
          </div>

          {c.nci.length > 0 && (
            <Panel className="overflow-hidden">
              <Head>Non-controlling interest</Head>
              <div className="sw-scroll">
                <table className="sw-table">
                  <caption className="sr-only">The minority&rsquo;s share of each part-owned member</caption>
                  <thead>
                    <tr>
                      <th>Entity</th>
                      <th className="sw-num" style={{ width: "7rem" }}>Minority</th>
                      <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Member net assets</th>
                      <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>NCI net assets</th>
                      <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Member profit</th>
                      <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>NCI profit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {c.nci.map((n) => (
                      <tr key={n.entityId} data-testid="nci-row">
                        <td className="sw-code">{n.entityId}</td>
                        <td className="sw-num">{pct(n.minorityBps)}</td>
                        <td className="sw-num"><Figure minor={n.memberNetAssetsMinor} currency={c.currency} zero="zero" /></td>
                        <td className="sw-num"><Figure minor={n.netAssetsMinor} currency={c.currency} zero="zero" /></td>
                        <td className="sw-num"><Figure minor={n.memberProfitMinor} currency={c.currency} zero="zero" /></td>
                        <td className="sw-num"><Figure minor={n.profitMinor} currency={c.currency} zero="zero" /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="sw-sub px-3 py-2" style={{ borderTop: "1px solid var(--sw-line)" }}>
                Every member above is included at 100% in each line of the statements. This table only says how much
                of the group&rsquo;s net assets and profit belongs to shareholders outside it.
              </p>
            </Panel>
          )}
        </div>
      )}
    </>
  );
}

function Head({ children }: { children: React.ReactNode }) {
  return (
    <div className="border-b px-3 py-2" style={{ borderColor: "var(--sw-line)", background: "var(--sw-surface-2)" }}>
      <span className="sw-label">{children}</span>
    </div>
  );
}

function ColumnHead({ order, eliminated }: { order: string[]; eliminated: boolean }) {
  return (
    <thead>
      <tr>
        <th style={{ width: "5rem" }}>Code</th>
        <th style={{ minWidth: "11rem" }}>Account</th>
        {order.map((e) => (
          <th key={e} className="sw-num" style={{ width: "var(--sw-col-amount)" }} data-testid="member-column">{e}</th>
        ))}
        {eliminated && <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Eliminated</th>}
        <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Group</th>
      </tr>
    </thead>
  );
}

function Rows({
  section, order, currency, eliminated,
}: { section: Section; order: string[]; currency: string; eliminated: boolean }) {
  const span = order.length + (eliminated ? 4 : 3);
  return (
    <tbody>
      <tr>
        <td colSpan={span} style={{ background: "var(--sw-surface-2)", height: "1.75rem" }}>
          <span className="sw-label">{section.label}</span>
        </td>
      </tr>
      {section.lines.length === 0 && (
        <tr><td colSpan={span} className="sw-sub" style={{ paddingInlineStart: "1.5rem" }}>Nothing in this period</td></tr>
      )}
      {section.lines.map((l) => (
        <tr key={l.code}>
          <td className="sw-code">{l.code}</td>
          <td>{l.name}</td>
          {order.map((e) => (
            <td key={e} className="sw-num"><Figure minor={l.byEntity[e] ?? "0"} currency={currency} /></td>
          ))}
          {eliminated && (
            <td className="sw-num"><Figure minor={`-${l.eliminationMinor}`} currency={currency} /></td>
          )}
          <td className="sw-num" style={{ fontWeight: 600 }}>
            <Figure minor={l.totalMinor} currency={currency} />
          </td>
        </tr>
      ))}
      <tr>
        <th scope="row" colSpan={2} style={{ textAlign: "end", fontWeight: 600 }}>
          Total {section.label.toLowerCase()}
        </th>
        {order.map((e) => (
          <td key={e} className="sw-num" style={{ fontWeight: 600 }}>
            <Figure minor={section.byEntity[e] ?? "0"} currency={currency} zero="zero" colour={false} />
          </td>
        ))}
        {eliminated && (
          <td className="sw-num" style={{ fontWeight: 600 }}>
            <Figure minor={`-${section.eliminationMinor}`} currency={currency} zero="zero" colour={false} />
          </td>
        )}
        <td className="sw-num" style={{ fontWeight: 600 }} data-testid={`section-total-${section.key}`}>
          <Figure minor={section.totalMinor} currency={currency} zero="zero" colour={false} />
        </td>
      </tr>
    </tbody>
  );
}

function Subtotal({
  label, minor, currency, span, testId,
}: { label: string; minor: string; currency: string; span: number; testId?: string }) {
  return (
    <tbody>
      <tr>
        <th scope="row" colSpan={span} style={{ textAlign: "end", fontWeight: 600, borderTop: "1px solid var(--sw-line-strong)" }}>
          {label}
        </th>
        <td className="sw-num" style={{ fontWeight: 600, borderTop: "1px solid var(--sw-line-strong)" }} data-testid={testId}>
          <Figure minor={minor} currency={currency} zero="zero" />
        </td>
      </tr>
    </tbody>
  );
}
