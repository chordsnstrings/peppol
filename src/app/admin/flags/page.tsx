"use client";

import * as React from "react";
import { ToggleRight, AlertTriangle, Fingerprint } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Switch } from "@/components/ui/controls";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/feedback";
import { toast } from "sonner";

interface Known { key: string; label: string; desc: string }
interface Flag { key: string; value: string; updatedAt: string | null }
interface Abuse { duplicateTrn: { trn: string; orgCount: number }[]; suspendedCount: number; newSignups24h: number }

export default function FlagsPage() {
  const [flags, setFlags] = React.useState<Flag[] | null>(null);
  const [known, setKnown] = React.useState<Known[]>([]);
  const [abuse, setAbuse] = React.useState<Abuse | null>(null);
  const [role, setRole] = React.useState("read_only");
  const canWrite = role === "super" || role === "support";

  const load = React.useCallback(() => {
    fetch("/api/admin/flags", { credentials: "same-origin" }).then((r) => r.json()).then((b) => { setFlags(b.flags ?? []); setKnown(b.known ?? []); }).catch(() => {});
    fetch("/api/admin/abuse", { credentials: "same-origin" }).then((r) => r.json()).then(setAbuse).catch(() => {});
  }, []);

  React.useEffect(() => {
    load();
    fetch("/api/admin/me", { credentials: "same-origin" }).then((r) => r.json()).then((b) => setRole(b.admin?.role ?? "read_only")).catch(() => {});
  }, [load]);

  const toggle = async (key: string, on: boolean) => {
    try {
      const res = await fetch("/api/admin/flags", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: JSON.stringify({ key, on }) });
      if (!res.ok) throw new Error();
      toast.success(`${key} ${on ? "on" : "off"}`);
      load();
    } catch {
      toast.error("Couldn't update flag");
    }
  };

  const flagVal = (key: string) => flags?.find((f) => f.key === key)?.value === "true";

  return (
    <div>
      <div className="flex items-center gap-3">
        <ToggleRight className="size-6" />
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight">Flags &amp; signals</h1>
          <p className="text-sm text-muted-foreground">Kill switches and abuse signals across the platform.</p>
        </div>
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        {/* Flags */}
        <Card>
          <CardContent className="p-5">
            <h2 className="font-display font-semibold">Kill switches</h2>
            <div className="mt-3 space-y-3">
              {!flags ? <Skeleton className="h-16 w-full" /> : known.map((k) => (
                <div key={k.key} className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium">{k.label}</p>
                    <p className="text-xs text-muted-foreground">{k.desc}</p>
                  </div>
                  <Switch checked={flagVal(k.key)} disabled={!canWrite} onCheckedChange={(v) => toggle(k.key, v)} />
                </div>
              ))}
            </div>
            {!canWrite && <p className="mt-3 text-xs text-muted-foreground">Read-only operators can't change flags.</p>}
          </CardContent>
        </Card>

        {/* Signals */}
        <Card>
          <CardContent className="p-5">
            <h2 className="font-display font-semibold">Signals</h2>
            {!abuse ? <Skeleton className="mt-3 h-16 w-full" /> : (
              <>
                <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
                  <div className="rounded-lg bg-muted/50 p-3">
                    <p className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">Suspended</p>
                    <p className="mt-1 font-display text-xl font-bold tabular-nums">{abuse.suspendedCount}</p>
                  </div>
                  <div className="rounded-lg bg-muted/50 p-3">
                    <p className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">Signups 24h</p>
                    <p className="mt-1 font-display text-xl font-bold tabular-nums">{abuse.newSignups24h}</p>
                  </div>
                </div>
                <div className="mt-4">
                  <p className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
                    <Fingerprint className="size-3.5" /> Duplicate TRNs (across orgs)
                  </p>
                  {abuse.duplicateTrn.length === 0 ? (
                    <p className="mt-2 text-sm text-muted-foreground">None detected.</p>
                  ) : (
                    <div className="mt-2 space-y-1.5">
                      {abuse.duplicateTrn.map((d) => (
                        <div key={d.trn} className="flex items-center justify-between text-sm">
                          <span className="flex items-center gap-1.5"><AlertTriangle className="size-3.5 text-warning" /> <span className="font-mono text-xs">{d.trn}</span></span>
                          <Badge tone="warning" size="sm">{d.orgCount} orgs</Badge>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
