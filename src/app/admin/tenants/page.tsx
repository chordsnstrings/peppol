"use client";

import * as React from "react";
import Link from "next/link";
import { Search, Building2, ChevronRight } from "lucide-react";
import { timeAgo } from "@/lib/utils";
import { PLAN_BY_CODE, type PlanCode } from "@/lib/domain/billing";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/feedback";

interface TenantRow {
  id: string;
  name: string;
  slug: string;
  status: string;
  createdAt: string;
  users: number;
  entities: number;
  invoices: number;
  plan: PlanCode;
  usage: number;
  allowance: number;
  lastActivityAt: string | null;
}

function statusTone(s: string): "success" | "warning" | "neutral" {
  return s === "active" ? "success" : s === "suspended" ? "warning" : "neutral";
}

export default function TenantsPage() {
  const [q, setQ] = React.useState("");
  const [rows, setRows] = React.useState<TenantRow[] | null>(null);

  const load = React.useCallback(async (search: string) => {
    setRows(null);
    const res = await fetch(`/api/admin/tenants${search ? `?q=${encodeURIComponent(search)}` : ""}`, { credentials: "same-origin" });
    const body = await res.json();
    setRows(body.tenants ?? []);
  }, []);

  React.useEffect(() => {
    load("");
  }, [load]);

  React.useEffect(() => {
    const t = setTimeout(() => load(q), 250);
    return () => clearTimeout(t);
  }, [q, load]);

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight">Tenants</h1>
          <p className="text-sm text-muted-foreground">{rows ? `${rows.length} workspaces` : "Loading…"}</p>
        </div>
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name or slug…"
            className="w-64 rounded-lg border border-border bg-background py-2 pl-9 pr-3 text-sm outline-none ring-primary/30 focus:ring-2"
          />
        </div>
      </div>

      <Card className="mt-5 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
                <th className="px-4 py-2.5 font-medium">Workspace</th>
                <th className="px-4 py-2.5 font-medium">Plan</th>
                <th className="px-3 py-2.5 text-right font-medium">Users</th>
                <th className="px-3 py-2.5 text-right font-medium">Invoices</th>
                <th className="px-3 py-2.5 text-right font-medium">Usage</th>
                <th className="px-4 py-2.5 font-medium">Activity</th>
                <th className="px-2 py-2.5"></th>
              </tr>
            </thead>
            <tbody>
              {!rows ? (
                Array.from({ length: 6 }).map((_, i) => (
                  <tr key={i} className="border-b border-border/60">
                    <td className="px-4 py-3" colSpan={7}><Skeleton className="h-5 w-full" /></td>
                  </tr>
                ))
              ) : rows.length === 0 ? (
                <tr><td className="px-4 py-8 text-center text-muted-foreground" colSpan={7}>No workspaces found.</td></tr>
              ) : (
                rows.map((t) => (
                  <tr key={t.id} className="group border-b border-border/60 last:border-0 hover:bg-muted/40">
                    <td className="px-4 py-3">
                      <Link href={`/admin/tenants/${t.id}`} className="flex items-center gap-2.5">
                        <div className="flex size-8 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                          <Building2 className="size-4" />
                        </div>
                        <div className="min-w-0">
                          <p className="truncate font-medium">{t.name}</p>
                          <p className="truncate font-mono text-[11px] text-muted-foreground">{t.slug}</p>
                        </div>
                        {t.status !== "active" && <Badge tone={statusTone(t.status)} size="sm">{t.status}</Badge>}
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      <Badge tone={t.plan === "FREE_MANDATE" ? "neutral" : "gold"} size="sm">{PLAN_BY_CODE[t.plan].name}</Badge>
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums">{t.users}</td>
                    <td className="px-3 py-3 text-right tabular-nums">{t.invoices}</td>
                    <td className="px-3 py-3 text-right tabular-nums">
                      <span className={t.usage > t.allowance ? "text-warning" : ""}>{t.usage}</span>
                      <span className="text-muted-foreground">/{t.allowance}</span>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{t.lastActivityAt ? timeAgo(t.lastActivityAt) : "—"}</td>
                    <td className="px-2 py-3">
                      <Link href={`/admin/tenants/${t.id}`} className="text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
                        <ChevronRight className="size-4" />
                      </Link>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
