"use client";

import * as React from "react";
import { ShieldCheck, Plus, Trash2, Crown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";

interface DbAdmin {
  userId: string;
  email: string;
  name: string;
  role: string;
  createdAt: string;
}

const inputCls =
  "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none ring-primary/30 focus:ring-2";

export default function OperatorsPage() {
  const [allowlist, setAllowlist] = React.useState<string[]>([]);
  const [admins, setAdmins] = React.useState<DbAdmin[]>([]);
  const [email, setEmail] = React.useState("");
  const [role, setRole] = React.useState("support");
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    const res = await fetch("/api/admin/admins", { credentials: "same-origin" });
    if (!res.ok) return;
    const body = await res.json();
    setAllowlist(body.allowlist ?? []);
    setAdmins(body.admins ?? []);
  }, []);

  React.useEffect(() => {
    load();
  }, [load]);

  const add = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/admin/admins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ email: email.trim(), role }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Couldn't grant");
      toast.success(`${body.email} is now ${body.role.replace("_", " ")}`);
      setEmail("");
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't grant");
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (a: DbAdmin) => {
    await fetch(`/api/admin/admins/${a.userId}`, { method: "DELETE", credentials: "same-origin" }).catch(() => {});
    toast.success(`Revoked ${a.email}`);
    load();
  };

  return (
    <div className="max-w-3xl">
      <div className="flex items-center gap-3">
        <ShieldCheck className="size-6 text-foreground" />
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight">Operators</h1>
          <p className="text-sm text-muted-foreground">Who can access the staff console, and at what level.</p>
        </div>
      </div>

      {/* Allowlist roots */}
      <Card className="mt-6">
        <CardContent className="p-5">
          <div className="flex items-center gap-2">
            <Crown className="size-4 text-gold" />
            <h2 className="font-display font-semibold">Root operators (env allowlist)</h2>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Set in <code className="rounded bg-muted px-1 text-xs">PLATFORM_ADMINS</code>. Always super; can't be
            removed here.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {allowlist.length === 0 ? (
              <span className="text-sm text-muted-foreground">None configured.</span>
            ) : (
              allowlist.map((e) => (
                <span key={e} className="rounded-lg bg-muted px-2.5 py-1 font-mono text-xs">
                  {e}
                </span>
              ))
            )}
          </div>
        </CardContent>
      </Card>

      {/* Grant */}
      <Card className="mt-4">
        <CardContent className="p-5">
          <h2 className="font-display font-semibold">Grant access</h2>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="teammate@arks.ae (must have signed up)"
              className={inputCls}
            />
            <select value={role} onChange={(e) => setRole(e.target.value)} className={`${inputCls} sm:w-44`}>
              <option value="support">Support</option>
              <option value="read_only">Read only</option>
              <option value="super">Super admin</option>
            </select>
            <Button icon={<Plus />} loading={busy} onClick={add}>
              Grant
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* DB admins */}
      <div className="mt-4">
        {admins.length === 0 ? (
          <p className="px-1 text-sm text-muted-foreground">No operators granted in-app yet.</p>
        ) : (
          <Card className="divide-y divide-border">
            {admins.map((a) => (
              <CardContent key={a.userId} className="flex items-center gap-3 !p-4">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{a.email}</p>
                  {a.name && <p className="text-xs text-muted-foreground">{a.name}</p>}
                </div>
                <Badge tone={a.role === "super" ? "gold" : "neutral"}>{a.role.replace("_", " ")}</Badge>
                <Button variant="ghost" size="icon-sm" onClick={() => revoke(a)} aria-label="Revoke">
                  <Trash2 className="size-4" />
                </Button>
              </CardContent>
            ))}
          </Card>
        )}
      </div>
    </div>
  );
}
