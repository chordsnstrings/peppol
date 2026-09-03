"use client";

import * as React from "react";
import { api, ApiError, useLedgerQuery } from "@/components/ledger/use-ledger";
import { PageHead, Panel, ErrorNote, Loading, Empty } from "@/components/ledger/primitives";

interface PermissionDef { key: string; group: string; label: string; effect: string }
interface Conflict { a: string; b: string; weight: "control" | "note"; why: string }
interface Role {
  code: string; name: string; description: string | null;
  builtIn: boolean; status: string; permissions: string[];
  conflicts: Conflict[]; assignedCount: number;
}
interface Person {
  userId: string; name: string | null; email: string;
  grants: { roleCode: string; roleName: string; entityId: string }[];
  permissions: string[]; conflicts: Conflict[];
}
interface Overview {
  roles: Role[]; people: Person[]; catalogue: PermissionDef[];
  unconfigured: boolean; unassigned: string[];
}

export default function RolesPage() {
  const { data, error, loading, reload } = useLedgerQuery<Overview>("/api/ledger/roles");
  const [busy, setBusy] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [openRole, setOpenRole] = React.useState<string | null>(null);
  const [making, setMaking] = React.useState(false);

  const act = async (label: string, body: Record<string, unknown>) => {
    setBusy(label); setErr(null); setMsg(null);
    try {
      const r = await api<Record<string, unknown>>("/api/ledger/roles", {
        method: "POST", body: JSON.stringify(body),
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

  const label = (key: string) => data?.catalogue.find((p) => p.key === key)?.label ?? key;

  return (
    <>
      <PageHead
        title="Who may do what"
        sub={
          "Permissions are something a business turns on when it grows past one bookkeeper, not something an upgrade " +
          "does to it. Until a role is granted to somebody, every member can do everything — and this page says so " +
          "rather than pretending to enforce something it is not."
        }
        actions={
          <>
            {data?.roles.length === 0 && (
              <button type="button" className="sw-btn sw-btn-primary" data-testid="seed-roles"
                disabled={busy === "seed"}
                onClick={async () => {
                  const r = await act("seed", { action: "seed" });
                  if (r) setMsg("The roles this product ships are now available to grant. Nothing is granted yet.");
                }}>
                Add the standard roles
              </button>
            )}
            <button type="button" className="sw-btn" onClick={() => setMaking((m) => !m)} data-testid="toggle-new-role">
              {making ? "Cancel" : "New role"}
            </button>
          </>
        }
      />

      {err && <ErrorNote>{err}</ErrorNote>}
      {msg && <div className="sw-note mb-3" role="status" data-testid="roles-result">{msg}</div>}
      {error && <ErrorNote>{error}</ErrorNote>}
      {loading && !data && <Loading />}

      {data && (
        <>
          {data.unconfigured && (
            <Panel className="mb-4 p-4">
              <div className="sw-label">Nothing is enforced yet</div>
              <p className="sw-sub mt-2 max-w-[70ch]" data-testid="roles-unconfigured">
                No role has been granted to anybody in this workspace, so every member can do everything. That is
                deliberate: a release that silently locked somebody out of their own books at the month end would be
                worse than no permissions at all. Grant one role and enforcement begins — including for you, so give
                somebody &ldquo;Manage roles&rdquo; before you finish.
              </p>
            </Panel>
          )}

          {data.unassigned.length > 0 && (
            <Panel className="mb-4 p-3">
              <div className="sw-label">Holding nothing</div>
              <p className="sw-sub mt-1.5" data-testid="roles-unassigned">
                {data.unassigned.join(", ")} {data.unassigned.length === 1 ? "has" : "have"} no role, so{" "}
                {data.unassigned.length === 1 ? "they can" : "they can"} do nothing at all. That is usually an
                oversight rather than a decision.
              </p>
            </Panel>
          )}

          {making && (
            <NewRole
              catalogue={data.catalogue}
              busy={busy === "create"}
              onCreate={async (role) => {
                const r = await act("create", { action: "create", ...role });
                if (r) { setMaking(false); setMsg(`Created ${role.code}. Nobody holds it yet.`); }
              }}
            />
          )}

          <Panel className="mb-4 overflow-hidden">
            <div className="sw-scroll">
              <table className="sw-table">
                <caption className="sr-only">Roles in this workspace</caption>
                <thead>
                  <tr>
                    <th style={{ width: "10rem" }}>Code</th>
                    <th>Role</th>
                    <th className="sw-num" style={{ width: "5rem" }}>Grants</th>
                    <th className="sw-num" style={{ width: "6rem" }}>People</th>
                    <th style={{ width: "9rem" }}>Separation</th>
                    <th style={{ width: "5rem" }} />
                  </tr>
                </thead>
                <tbody data-testid="role-rows">
                  {data.roles.map((r) => (
                    <React.Fragment key={r.code}>
                      <tr>
                        <td className="sw-code">{r.code}</td>
                        <td className="max-w-0 truncate">
                          {r.name}
                          {r.builtIn && <span className="sw-chip ml-1.5">shipped</span>}
                          {r.description && <div className="sw-sub truncate">{r.description}</div>}
                        </td>
                        <td className="sw-num">{r.permissions.length}</td>
                        <td className="sw-num">{r.assignedCount}</td>
                        <td>
                          {r.conflicts.some((c) => c.weight === "control") ? (
                            <span className="sw-chip sw-chip-bad">control weakened</span>
                          ) : r.conflicts.length ? (
                            <span className="sw-chip">worth knowing</span>
                          ) : (
                            <span className="sw-chip sw-chip-good">clean</span>
                          )}
                        </td>
                        <td>
                          <button type="button" className="sw-link-btn"
                            aria-expanded={openRole === r.code}
                            onClick={() => setOpenRole(openRole === r.code ? null : r.code)}>
                            {openRole === r.code ? "Hide" : "Open"}
                          </button>
                        </td>
                      </tr>
                      {openRole === r.code && (
                        <tr>
                          <td colSpan={6} style={{ background: "var(--sw-ground)" }}>
                            <div className="p-3">
                              <div className="sw-label">What it grants</div>
                              <ul className="mt-1.5 grid gap-1 sm:grid-cols-2">
                                {r.permissions.map((p) => {
                                  const def = data.catalogue.find((c) => c.key === p);
                                  return (
                                    <li key={p} className="sw-sub">
                                      <span className="sw-code">{def?.label ?? p}</span> — {def?.effect ?? ""}
                                    </li>
                                  );
                                })}
                              </ul>
                              {r.conflicts.length > 0 && (
                                <>
                                  <div className="sw-label mt-3">Where it puts two jobs in one pair of hands</div>
                                  <ul className="mt-1.5 space-y-1">
                                    {r.conflicts.map((c) => (
                                      <li key={`${c.a}:${c.b}`} className="sw-sub">
                                        <span className={`sw-chip ${c.weight === "control" ? "sw-chip-bad" : ""}`}>
                                          {c.weight === "control" ? "control" : "note"}
                                        </span>{" "}
                                        {label(c.a)} and {label(c.b)} — {c.why}
                                      </li>
                                    ))}
                                  </ul>
                                </>
                              )}
                              <div className="mt-3 flex flex-wrap items-end gap-2">
                                <GrantForm
                                  people={data.people}
                                  busy={busy === `assign:${r.code}`}
                                  onGrant={async (userId, entityId) => {
                                    const g = await act(`assign:${r.code}`, {
                                      action: "assign", userId, roleCode: r.code, entityId: entityId || undefined,
                                    });
                                    if (g) setMsg(`Granted ${r.code}${entityId ? ` on ${entityId}` : " on every entity"}.`);
                                  }}
                                />
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            </div>
            {data.roles.length === 0 && <Empty>No roles yet. Add the standard ones to begin.</Empty>}
          </Panel>

          <Panel className="overflow-hidden">
            <div className="sw-scroll">
              <table className="sw-table">
                <caption className="sr-only">People and what each of them can do</caption>
                <thead>
                  <tr>
                    <th style={{ width: "14rem" }}>Person</th>
                    <th>Roles</th>
                    <th className="sw-num" style={{ width: "6rem" }}>Can do</th>
                    <th style={{ width: "9rem" }}>Separation</th>
                  </tr>
                </thead>
                <tbody data-testid="people-rows">
                  {data.people.map((p) => (
                    <tr key={p.userId}>
                      <td>
                        {p.name ?? "—"}
                        <div className="sw-sub">{p.email}</div>
                      </td>
                      <td>
                        {p.grants.length === 0 ? (
                          <span className="sw-sub">nothing granted</span>
                        ) : (
                          <ul className="flex flex-wrap gap-1">
                            {p.grants.map((g) => (
                              <li key={`${g.roleCode}:${g.entityId}`}>
                                <span className="sw-chip">
                                  {g.roleCode}
                                  {g.entityId !== "*" && <span className="sw-sub"> on {g.entityId}</span>}
                                </span>{" "}
                                <button type="button" className="sw-link-btn"
                                  disabled={busy === `revoke:${p.userId}:${g.roleCode}`}
                                  onClick={async () => {
                                    const r = await act(`revoke:${p.userId}:${g.roleCode}`, {
                                      action: "revoke", userId: p.userId, roleCode: g.roleCode,
                                      entityId: g.entityId === "*" ? undefined : g.entityId,
                                    });
                                    if (r) setMsg(`Took ${g.roleCode} away from ${p.email}.`);
                                  }}>
                                  remove
                                </button>
                              </li>
                            ))}
                          </ul>
                        )}
                      </td>
                      <td className="sw-num">{p.permissions.length}</td>
                      <td>
                        {p.conflicts.some((c) => c.weight === "control") ? (
                          <span className="sw-chip sw-chip-bad" title={p.conflicts.find((c) => c.weight === "control")!.why}>
                            control weakened
                          </span>
                        ) : p.conflicts.length ? (
                          <span className="sw-chip" title={p.conflicts[0].why}>worth knowing</span>
                        ) : (
                          <span className="sw-sub">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>

          <p className="sw-sub mt-3 max-w-[75ch]">
            A conflict is reported, never refused. A one-person business genuinely needs to prepare a payment and
            approve it, and software that refuses to let a sole trader pay a supplier is software that gets worked
            around. The controls that must not be negotiable live in the database instead, where nobody negotiates
            with them — a payment run&rsquo;s approver can never be its preparer, whatever role either of them holds.
          </p>
        </>
      )}
    </>
  );
}

function GrantForm({ people, busy, onGrant }: {
  people: Person[]; busy: boolean; onGrant: (userId: string, entityId: string) => void;
}) {
  const [userId, setUserId] = React.useState("");
  const [entityId, setEntityId] = React.useState("");
  return (
    <>
      <label className="flex items-center gap-1.5">
        <span className="sw-label">Grant to</span>
        <select className="sw-select" style={{ width: "13rem" }} value={userId}
          onChange={(e) => setUserId(e.target.value)} aria-label="Person to grant this role to">
          <option value="">choose somebody</option>
          {people.map((p) => <option key={p.userId} value={p.userId}>{p.name ?? p.email}</option>)}
        </select>
      </label>
      <label className="flex items-center gap-1.5">
        <span className="sw-label">On entity</span>
        <input className="sw-input" style={{ width: "11rem" }} value={entityId}
          onChange={(e) => setEntityId(e.target.value)} placeholder="every entity"
          aria-label="Entity this grant applies to, or blank for all of them" />
      </label>
      <button type="button" className="sw-btn sw-btn-sm" disabled={!userId || busy}
        onClick={() => onGrant(userId, entityId.trim())}>
        Grant
      </button>
    </>
  );
}

function NewRole({ catalogue, busy, onCreate }: {
  catalogue: PermissionDef[];
  busy: boolean;
  onCreate: (r: { code: string; name: string; description: string; permissions: string[] }) => void;
}) {
  const [code, setCode] = React.useState("");
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [chosen, setChosen] = React.useState<string[]>([]);
  const [err, setErr] = React.useState<string | null>(null);

  const groups = [...new Set(catalogue.map((c) => c.group))];
  const toggle = (key: string) =>
    setChosen((c) => (c.includes(key) ? c.filter((k) => k !== key) : [...c, key]));

  return (
    <Panel className="mb-4 p-4">
      <div className="sw-label">A role of your own</div>
      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <label className="block">
          <span className="sw-label">Code</span>
          <input className="sw-input mt-1" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="CREDIT_CONTROL" />
        </label>
        <label className="block">
          <span className="sw-label">Name</span>
          <input className="sw-input mt-1" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="block">
          <span className="sw-label">What it is for</span>
          <input className="sw-input mt-1" value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
      </div>

      {groups.map((g) => (
        <fieldset key={g} className="mt-3">
          <legend className="sw-label">{g}</legend>
          <ul className="mt-1.5 grid gap-1 sm:grid-cols-2">
            {catalogue.filter((c) => c.group === g).map((c) => (
              <li key={c.key}>
                <label className="flex items-start gap-2">
                  <input type="checkbox" className="mt-0.5" checked={chosen.includes(c.key)}
                    onChange={() => toggle(c.key)} />
                  <span>
                    {c.label}
                    <span className="sw-sub block">{c.effect}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
      ))}

      {err && <div className="sw-error mt-2" role="alert">{err}</div>}

      <button type="button" className="sw-btn sw-btn-primary mt-3" disabled={busy} data-testid="save-role"
        onClick={() => {
          if (!code.trim()) { setErr("A role needs a code."); return; }
          if (!chosen.length) { setErr("A role that grants nothing will be assigned by mistake and then wondered about."); return; }
          setErr(null);
          onCreate({ code: code.trim(), name: name.trim() || code.trim(), description: description.trim(), permissions: chosen });
        }}>
        {busy ? "Saving…" : "Create the role"}
      </button>
    </Panel>
  );
}
