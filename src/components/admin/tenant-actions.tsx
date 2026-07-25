"use client";

import * as React from "react";
import { Ban, CheckCircle2, Lock, Wallet, KeyRound, Unplug, ShieldOff, Eye, Download, Trash2 } from "lucide-react";
import { PLANS, type PlanCode } from "@/lib/domain/billing";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Modal, ConfirmDialog } from "@/components/ui/modal";
import { toast } from "sonner";

interface Detail {
  org: { status: string };
  billing: { plan: PlanCode; allowance: number; override: number | null };
  apiKeys: { id: string; name: string; prefix: string }[];
  connections: { id: string; provider: string }[];
  oauthGrants: number;
}

const inputCls = "rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none ring-primary/30 focus:ring-2";

export function TenantActions({ orgId, orgName, detail, canWrite, isSuper, onDone }: { orgId: string; orgName: string; detail: Detail; canWrite: boolean; isSuper: boolean; onDone: () => void }) {
  const [plan, setPlan] = React.useState<PlanCode>(detail.billing.plan);
  const [allowance, setAllowance] = React.useState(detail.billing.override?.toString() ?? "");
  const [busy, setBusy] = React.useState("");
  const [statusModal, setStatusModal] = React.useState<null | "suspended" | "readonly">(null);
  const [impersonateOpen, setImpersonateOpen] = React.useState(false);
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [delName, setDelName] = React.useState("");
  const [delReason, setDelReason] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [confirm, setConfirm] = React.useState<null | { title: string; desc: string; run: () => Promise<void> }>(null);

  if (!canWrite) return null;

  const post = async (path: string, body: unknown, label: string, ok: string) => {
    setBusy(label);
    try {
      const res = await fetch(`/api/admin/tenants/${orgId}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(body),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? "Action failed");
      toast.success(ok);
      onDone();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusy("");
    }
  };

  return (
    <>
      <Card className="border-destructive/20">
        <CardContent className="space-y-5 p-5">
          <div className="flex items-center justify-between gap-2">
            <h2 className="font-display font-semibold">Operator actions</h2>
            <Button size="sm" variant="outline" icon={<Eye />} onClick={() => { setReason(""); setImpersonateOpen(true); }}>
              View as tenant
            </Button>
          </div>

          {/* Plan */}
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex-1">
              <label className="mb-1 block font-mono text-[11px] uppercase tracking-wider text-muted-foreground">Plan</label>
              <select value={plan} onChange={(e) => setPlan(e.target.value as PlanCode)} className={`${inputCls} w-full`}>
                {PLANS.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}
              </select>
            </div>
            <Button size="sm" variant="outline" icon={<Wallet />} loading={busy === "plan"} disabled={plan === detail.billing.plan} onClick={() => post("/plan", { plan }, "plan", "Plan updated")}>
              Apply plan
            </Button>
          </div>

          {/* Allowance override */}
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex-1">
              <label className="mb-1 block font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
                Allowance override {detail.billing.override !== null && <span className="text-warning">(active: {detail.billing.override})</span>}
              </label>
              <input value={allowance} onChange={(e) => setAllowance(e.target.value)} inputMode="numeric" placeholder={`plan default ${detail.billing.allowance}`} className={`${inputCls} w-full`} />
            </div>
            <Button size="sm" variant="outline" loading={busy === "allowance"} onClick={() => post("/allowance", { allowance: allowance.trim() === "" ? null : Number(allowance) }, "allowance", "Allowance set")}>
              Set
            </Button>
            {detail.billing.override !== null && (
              <Button size="sm" variant="ghost" onClick={() => { setAllowance(""); post("/allowance", { allowance: null }, "allowance", "Override cleared"); }}>
                Clear
              </Button>
            )}
          </div>

          {/* Status */}
          <div>
            <label className="mb-1 block font-mono text-[11px] uppercase tracking-wider text-muted-foreground">Lifecycle</label>
            <div className="flex flex-wrap gap-2">
              {detail.org.status !== "active" && (
                <Button size="sm" variant="outline" icon={<CheckCircle2 />} loading={busy === "status"} onClick={() => post("/status", { status: "active" }, "status", "Reactivated")}>
                  Reactivate
                </Button>
              )}
              {detail.org.status !== "readonly" && (
                <Button size="sm" variant="outline" icon={<Lock />} onClick={() => { setReason(""); setStatusModal("readonly"); }}>
                  Set read-only
                </Button>
              )}
              {detail.org.status !== "suspended" && (
                <Button size="sm" variant="outline" className="text-destructive" icon={<Ban />} onClick={() => { setReason(""); setStatusModal("suspended"); }}>
                  Suspend
                </Button>
              )}
            </div>
          </div>

          {/* Credentials */}
          <div className="border-t border-border pt-4">
            <label className="mb-2 block font-mono text-[11px] uppercase tracking-wider text-muted-foreground">Credentials</label>
            <div className="space-y-2">
              {detail.apiKeys.length === 0 && detail.connections.length === 0 && detail.oauthGrants === 0 && (
                <p className="text-sm text-muted-foreground">No active credentials.</p>
              )}
              {detail.apiKeys.map((k) => (
                <div key={k.id} className="flex items-center justify-between gap-2 text-sm">
                  <span className="flex items-center gap-2"><KeyRound className="size-3.5 text-muted-foreground" /> <span className="font-mono text-xs">{k.prefix}…</span> {k.name}</span>
                  <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setConfirm({ title: "Revoke API key?", desc: `${k.name} stops working immediately.`, run: () => post("/revoke", { target: "apiKey", id: k.id }, "", "Key revoked") })}>
                    Revoke
                  </Button>
                </div>
              ))}
              {detail.oauthGrants > 0 && (
                <div className="flex items-center justify-between gap-2 text-sm">
                  <span className="flex items-center gap-2"><ShieldOff className="size-3.5 text-muted-foreground" /> {detail.oauthGrants} OAuth grant(s)</span>
                  <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setConfirm({ title: "Revoke all OAuth access?", desc: "Every connected AI/app for this tenant is signed out.", run: () => post("/revoke", { target: "oauth" }, "", "OAuth grants revoked") })}>
                    Revoke all
                  </Button>
                </div>
              )}
              {detail.connections.map((c) => (
                <div key={c.id} className="flex items-center justify-between gap-2 text-sm">
                  <span className="flex items-center gap-2"><Unplug className="size-3.5 text-muted-foreground" /> {c.provider}</span>
                  <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setConfirm({ title: "Force-disconnect?", desc: `${c.provider} integration is removed for this tenant.`, run: () => post("/revoke", { target: "integration", id: c.id }, "", "Disconnected") })}>
                    Disconnect
                  </Button>
                </div>
              ))}
            </div>
          </div>

          {/* Danger zone (super only) */}
          {isSuper && (
            <div className="border-t border-destructive/20 pt-4">
              <label className="mb-2 block font-mono text-[11px] uppercase tracking-wider text-destructive">Danger zone</label>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" icon={<Download />} onClick={() => window.open(`/api/admin/tenants/${orgId}/export`, "_blank")}>
                  Export data
                </Button>
                <Button size="sm" variant="outline" className="text-destructive" icon={<Trash2 />} onClick={() => { setDelName(""); setDelReason(""); setDeleteOpen(true); }}>
                  Delete workspace
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Delete confirmation (super only) */}
      <Modal open={deleteOpen} onClose={() => setDeleteOpen(false)} title="Delete workspace" size="sm">
        <div className="space-y-3 p-5">
          <p className="text-sm text-muted-foreground">
            This permanently deletes <b>{orgName}</b> and all its data. This cannot be undone. Type the name to
            confirm and give a reason.
          </p>
          <input value={delName} onChange={(e) => setDelName(e.target.value)} placeholder={orgName} className={`${inputCls} w-full`} />
          <textarea value={delReason} onChange={(e) => setDelReason(e.target.value)} rows={2} placeholder="Reason" className={`${inputCls} w-full`} />
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setDeleteOpen(false)}>Cancel</Button>
            <Button
              className="text-destructive"
              disabled={delName !== orgName || !delReason.trim()}
              loading={busy === "delete"}
              onClick={async () => {
                setBusy("delete");
                try {
                  const res = await fetch(`/api/admin/tenants/${orgId}/delete`, { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: JSON.stringify({ reason: delReason.trim(), confirmName: delName }) });
                  const j = await res.json().catch(() => ({}));
                  if (!res.ok) throw new Error(j.error ?? "Delete failed");
                  toast.success("Workspace deleted");
                  window.location.href = "/admin/tenants";
                } catch (e) {
                  toast.error(e instanceof Error ? e.message : "Delete failed");
                  setBusy("");
                }
              }}
            >
              Delete permanently
            </Button>
          </div>
        </div>
      </Modal>

      {/* Reason modal for suspend/readonly */}
      <Modal open={statusModal !== null} onClose={() => setStatusModal(null)} title={statusModal === "suspended" ? "Suspend workspace" : "Set read-only"} size="sm">
        <div className="space-y-3 p-5">
          <p className="text-sm text-muted-foreground">
            {statusModal === "suspended" ? "The tenant is blocked from creating or sending. A reason is required and logged." : "The tenant can read but not write. A reason is required and logged."}
          </p>
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} placeholder="Reason (e.g. non-payment, abuse report #123)" className={`${inputCls} w-full`} />
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setStatusModal(null)}>Cancel</Button>
            <Button
              className="text-destructive"
              disabled={!reason.trim()}
              loading={busy === "status"}
              onClick={async () => { await post("/status", { status: statusModal, reason: reason.trim() }, "status", statusModal === "suspended" ? "Suspended" : "Set read-only"); setStatusModal(null); }}
            >
              Confirm
            </Button>
          </div>
        </div>
      </Modal>

      {/* Impersonation reason */}
      <Modal open={impersonateOpen} onClose={() => setImpersonateOpen(false)} title="View as tenant" size="sm">
        <div className="space-y-3 p-5">
          <p className="text-sm text-muted-foreground">
            You'll see this workspace read-only for 15 minutes. The tenant is notified, and it's logged. Give a
            reason (e.g. a ticket number).
          </p>
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} placeholder="Reason (e.g. debug failed send, ticket #123)" className={`${inputCls} w-full`} />
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setImpersonateOpen(false)}>Cancel</Button>
            <Button
              icon={<Eye />}
              disabled={!reason.trim()}
              loading={busy === "impersonate"}
              onClick={async () => {
                setBusy("impersonate");
                try {
                  const res = await fetch(`/api/admin/tenants/${orgId}/impersonate`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    credentials: "same-origin",
                    body: JSON.stringify({ reason: reason.trim() }),
                  });
                  const j = await res.json().catch(() => ({}));
                  if (!res.ok) throw new Error(j.error ?? "Couldn't start");
                  window.location.href = "/dashboard";
                } catch (e) {
                  toast.error(e instanceof Error ? e.message : "Couldn't start");
                  setBusy("");
                }
              }}
            >
              Start viewing
            </Button>
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        onConfirm={async () => { const c = confirm; setConfirm(null); if (c) await c.run(); }}
        title={confirm?.title ?? ""}
        description={confirm?.desc ?? ""}
        confirmLabel="Confirm"
        tone="destructive"
      />
    </>
  );
}
