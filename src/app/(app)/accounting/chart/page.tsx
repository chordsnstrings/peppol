"use client";

import * as React from "react";
import Link from "next/link";
import { api, ApiError, useEntityId, useLedgerQuery } from "@/components/ledger/use-ledger";
import { Figure, PageHead, Panel, ErrorNote, Loading, Empty } from "@/components/ledger/primitives";

interface Row {
  code: string; name: string; nameAr: string | null; type: string; subtype: string | null;
  parentCode: string | null; isPostable: boolean; isControl: boolean;
  currency: string | null; requiresDimension: string | null; status: string;
  postedLines: number; balanceMinor: string; children: number;
  canChangeType: boolean; canDelete: boolean; canArchive: boolean;
}

const TYPES = ["ASSET", "LIABILITY", "EQUITY", "INCOME", "EXPENSE"] as const;
const TYPE_LABEL: Record<string, string> = {
  ASSET: "Assets", LIABILITY: "Liabilities", EQUITY: "Equity", INCOME: "Income", EXPENSE: "Expenses",
};

/**
 * Editing the chart.
 *
 * The rules about what may change once an account has been posted to live on
 * the server, but the screen shows them *before* anyone tries: a used account's
 * type control is disabled with the reason beside it rather than accepting the
 * change and refusing on submit. Being told no after filling in a form is how
 * people conclude a system is arbitrary.
 */
export default function ChartEditorPage() {
  const entityId = useEntityId();
  const { data, error, loading, reload } = useLedgerQuery<{ accounts: Row[] }>(
    entityId ? `/api/ledger/chart?entityId=${entityId}` : null,
  );
  const [q, setQ] = React.useState("");
  const [showArchived, setShowArchived] = React.useState(false);
  const [editing, setEditing] = React.useState<string | null>(null);
  const [adding, setAdding] = React.useState(false);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);

  const act = async (label: string, body: Record<string, unknown>, describe: string) => {
    setBusy(label); setErr(null); setMsg(null);
    try {
      await api("/api/ledger/chart", { method: "POST", body: JSON.stringify({ entityId, ...body }) });
      setMsg(describe);
      setEditing(null);
      setAdding(false);
      reload();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "That did not work.");
    } finally {
      setBusy(null);
    }
  };

  const accounts = React.useMemo(() => {
    const all = data?.accounts ?? [];
    const needle = q.trim().toLowerCase();
    return all.filter((a) => {
      if (!showArchived && a.status !== "active") return false;
      if (!needle) return true;
      return a.code.toLowerCase().startsWith(needle) || a.name.toLowerCase().includes(needle);
    });
  }, [data, q, showArchived]);

  if (!entityId) return <Loading label="Choosing an entity…" />;

  return (
    <>
      <PageHead
        title="Edit the chart"
        sub="What may still change depends on what an account already carries. A name is a label and can always change; a type is not, because moving an account between types rewrites every statement it has appeared in."
        actions={
          <>
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
              <span className="text-[0.8125rem]">Show archived</span>
            </label>
            <button type="button" className="sw-btn sw-btn-primary" onClick={() => { setAdding((a) => !a); setEditing(null); }}>
              {adding ? "Cancel" : "Add account"}
            </button>
          </>
        }
      />

      {err && <ErrorNote>{err}</ErrorNote>}
      {msg && <div className="sw-note mb-3" role="status" data-testid="chart-result">{msg}</div>}
      {error && <ErrorNote>{error}</ErrorNote>}

      {adding && (
        <AddForm
          existing={data?.accounts ?? []}
          busy={busy === "add"}
          onAdd={(account) => act("add", { action: "add", account }, `Added ${account.code} ${account.name}.`)}
        />
      )}

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor="chart-search">Search the chart</label>
        <input
          id="chart-search"
          className="sw-input max-w-[22rem]"
          placeholder="Code or name"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <span className="sw-sub ms-auto" aria-live="polite">
          {loading ? "" : `${accounts.length} account${accounts.length === 1 ? "" : "s"}`}
        </span>
      </div>

      {loading && !data && <Loading />}
      {!loading && accounts.length === 0 && <Empty>No accounts match.</Empty>}

      {TYPES.filter((t) => accounts.some((a) => a.type === t)).map((t) => (
        <Panel key={t} className="mb-4 overflow-hidden">
          <div className="border-b px-3 py-2" style={{ borderColor: "var(--sw-line)", background: "var(--sw-surface-2)" }}>
            <span className="sw-label">{TYPE_LABEL[t]}</span>
          </div>
          <div className="sw-scroll">
            <table className="sw-table">
              <caption className="sr-only">{TYPE_LABEL[t]} in the chart of accounts</caption>
              <thead>
                <tr>
                  <th style={{ width: "6rem" }}>Code</th>
                  <th>Name</th>
                  <th className="sw-num" style={{ width: "6rem" }}>Postings</th>
                  <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Balance</th>
                  <th style={{ width: "10rem" }}>Kind</th>
                  <th style={{ width: "13rem" }}><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {accounts.filter((a) => a.type === t).map((a) => (
                  <React.Fragment key={a.code}>
                    <tr>
                      <td className="sw-code">{a.code}</td>
                      <td style={{ paddingInlineStart: a.parentCode ? "1.5rem" : undefined }}>
                        <span style={{ fontWeight: a.isPostable ? 400 : 600 }}>{a.name}</span>
                      </td>
                      <td className="sw-num">{a.postedLines || <span className="sw-zero">–</span>}</td>
                      <td className="sw-num"><Figure minor={a.balanceMinor} /></td>
                      <td>
                        <span className="flex flex-wrap gap-1">
                          {!a.isPostable && <span className="sw-chip">heading</span>}
                          {a.isControl && <span className="sw-chip sw-chip-accent">control</span>}
                          {a.currency && <span className="sw-chip">{a.currency}</span>}
                          {a.status !== "active" && <span className="sw-chip sw-chip-warn">archived</span>}
                        </span>
                      </td>
                      <td>
                        <span className="flex flex-wrap gap-1 py-1">
                          <button
                            type="button"
                            className="sw-btn sw-btn-sm"
                            onClick={() => { setEditing(editing === a.code ? null : a.code); setAdding(false); }}
                            aria-expanded={editing === a.code}
                          >
                            {editing === a.code ? "Close" : "Edit"}
                          </button>
                          {a.status === "active" ? (
                            <button
                              type="button"
                              className="sw-btn sw-btn-sm"
                              aria-disabled={!a.canArchive || undefined}
                              disabled={!a.canArchive}
                              title={a.canArchive ? undefined : a.children > 0 ? "It still has accounts under it" : "It still holds a balance"}
                              onClick={() => act(a.code, { action: "archive", code: a.code }, `Archived ${a.code}. Its history is untouched.`)}
                            >
                              Archive
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="sw-btn sw-btn-sm"
                              onClick={() => act(a.code, { action: "restore", code: a.code }, `${a.code} is active again.`)}
                            >
                              Restore
                            </button>
                          )}
                        </span>
                      </td>
                    </tr>
                    {editing === a.code && (
                      <tr>
                        <td colSpan={6} style={{ background: "var(--sw-surface-2)", padding: "0.75rem" }}>
                          <EditForm
                            account={a}
                            busy={busy === a.code}
                            onSave={(change) => act(a.code, { action: "update", code: a.code, change }, `Updated ${a.code}.`)}
                            onRenumber={(toCode) => act(a.code, { action: "renumber", code: a.code, toCode }, `${a.code} is now ${toCode}.`)}
                            onDelete={() => act(a.code, { action: "delete", code: a.code }, `Deleted ${a.code}.`)}
                          />
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      ))}

      <p className="sw-sub">
        Deleting is only ever possible for an account nothing has been posted to. Anything else is archived, which
        stops new postings and keeps every past statement true.{" "}
        <Link href="/accounting/accounts" className="sw-link">The read-only chart</Link> is the one to hand to
        someone who only needs to look.
      </p>
    </>
  );
}

function EditForm({ account, busy, onSave, onRenumber, onDelete }: {
  account: Row;
  busy: boolean;
  onSave: (c: Record<string, unknown>) => void;
  onRenumber: (to: string) => void;
  onDelete: () => void;
}) {
  const [name, setName] = React.useState(account.name);
  const [nameAr, setNameAr] = React.useState(account.nameAr ?? "");
  const [type, setType] = React.useState(account.type);
  const [newCode, setNewCode] = React.useState("");

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Field label="Name">
        <input className="sw-input" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="العربية">
        <input className="sw-input" dir="rtl" value={nameAr} onChange={(e) => setNameAr(e.target.value)} />
      </Field>
      <Field label="Type">
        <select
          className="sw-select"
          value={type}
          onChange={(e) => setType(e.target.value)}
          disabled={!account.canChangeType}
          aria-describedby={account.canChangeType ? undefined : `why-${account.code}`}
        >
          {TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
        </select>
        {!account.canChangeType && (
          <span id={`why-${account.code}`} className="sw-sub mt-1 block">
            Frozen: {account.postedLines} posting{account.postedLines === 1 ? "" : "s"} depend on it.
          </span>
        )}
      </Field>
      <Field label="Renumber to">
        <span className="flex gap-1">
          <input className="sw-input" placeholder={account.code} value={newCode} onChange={(e) => setNewCode(e.target.value)} />
          <button
            type="button"
            className="sw-btn sw-btn-sm"
            aria-disabled={!newCode.trim() || busy || undefined}
            disabled={!newCode.trim() || busy}
            onClick={() => onRenumber(newCode.trim())}
          >
            Move
          </button>
        </span>
      </Field>

      <div className="flex flex-wrap items-center gap-2 sm:col-span-2 lg:col-span-4">
        <button
          type="button"
          className="sw-btn sw-btn-primary"
          disabled={busy}
          data-testid={`save-${account.code}`}
          onClick={() => onSave({
            name,
            nameAr: nameAr || null,
            ...(account.canChangeType && type !== account.type ? { type } : {}),
          })}
        >
          {busy ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          className="sw-btn sw-btn-sm"
          aria-disabled={!account.canDelete || undefined}
          disabled={!account.canDelete || busy}
          title={account.canDelete ? undefined : `${account.postedLines} postings depend on it — archive it instead`}
          onClick={onDelete}
        >
          Delete
        </button>
        {!account.canDelete && (
          <span className="sw-sub">
            Nothing that has been posted to can be deleted. Archive keeps the history and stops new postings.
          </span>
        )}
      </div>
    </div>
  );
}

function AddForm({ existing, busy, onAdd }: {
  existing: Row[];
  busy: boolean;
  onAdd: (a: Record<string, unknown>) => void;
}) {
  const [f, setF] = React.useState({ code: "", name: "", nameAr: "", type: "EXPENSE", parentCode: "", isPostable: true });
  const set = (k: keyof typeof f, v: string | boolean) => setF((x) => ({ ...x, [k]: v }));

  const headings = existing.filter((a) => !a.isPostable && a.type === f.type && a.status === "active");
  const taken = existing.some((a) => a.code === f.code.trim());

  const blocker =
    !f.code.trim() ? "Give the account a code." :
    !/^[A-Za-z0-9._-]+$/.test(f.code.trim()) ? "A code is letters, digits, dots, dashes or underscores." :
    taken ? `${f.code.trim()} is already in use.` :
    !f.name.trim() ? "Give the account a name." :
    null;

  return (
    <Panel className="mb-4 p-4">
      <div className="sw-label">Add an account</div>
      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Field label="Code"><input className="sw-input" value={f.code} onChange={(e) => set("code", e.target.value)} placeholder="6910" /></Field>
        <Field label="Name"><input className="sw-input" value={f.name} onChange={(e) => set("name", e.target.value)} /></Field>
        <Field label="العربية"><input className="sw-input" dir="rtl" value={f.nameAr} onChange={(e) => set("nameAr", e.target.value)} /></Field>
        <Field label="Type">
          <select className="sw-select" value={f.type} onChange={(e) => { set("type", e.target.value); set("parentCode", ""); }}>
            {TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
          </select>
        </Field>
        <Field label="Under">
          <select className="sw-select" value={f.parentCode} onChange={(e) => set("parentCode", e.target.value)}>
            <option value="">Nothing</option>
            {headings.map((h) => <option key={h.code} value={h.code}>{h.code} {h.name}</option>)}
          </select>
        </Field>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-[0.8125rem]">
          <input type="checkbox" checked={!f.isPostable} onChange={(e) => set("isPostable", !e.target.checked)} />
          <span>This is a heading — it rolls up its children and holds no balance of its own</span>
        </label>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="sw-btn sw-btn-primary"
          aria-disabled={blocker !== null || busy || undefined}
          disabled={blocker !== null || busy}
          data-testid="add-account"
          onClick={() => onAdd({
            code: f.code.trim(), name: f.name.trim(), nameAr: f.nameAr.trim() || undefined,
            type: f.type, parentCode: f.parentCode || undefined, isPostable: f.isPostable,
          })}
        >
          {busy ? "Adding…" : "Add"}
        </button>
        {blocker && <span className="sw-sub" role="status" data-testid="chart-blocker">{blocker}</span>}
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
