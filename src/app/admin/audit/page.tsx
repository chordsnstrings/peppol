"use client";

import * as React from "react";
import Link from "next/link";
import { ScrollText } from "lucide-react";
import { timeAgo } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/feedback";

interface Entry {
  id: string;
  adminEmail: string;
  action: string;
  targetOrgId: string | null;
  targetId: string | null;
  metadata: string | null;
  reason: string | null;
  ip: string | null;
  at: string;
}

const FILTERS = [
  { label: "All", value: "" },
  { label: "Operators", value: "admin." },
  { label: "Tenants", value: "tenant." },
  { label: "Flags", value: "flag." },
];

function actionTone(a: string): "warning" | "neutral" | "success" {
  if (a.includes("delete") || a.includes("suspend") || a.includes("revoke") || a.includes("impersonate")) return "warning";
  if (a.includes("grant") || a.includes("bootstrap")) return "success";
  return "neutral";
}

export default function AuditPage() {
  const [entries, setEntries] = React.useState<Entry[] | null>(null);
  const [filter, setFilter] = React.useState("");

  React.useEffect(() => {
    setEntries(null);
    fetch(`/api/admin/audit${filter ? `?action=${filter}` : ""}`, { credentials: "same-origin" })
      .then((r) => r.json())
      .then((b) => setEntries(b.entries ?? []))
      .catch(() => setEntries([]));
  }, [filter]);

  return (
    <div>
      <div className="flex items-center gap-3">
        <ScrollText className="size-6" />
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight">Audit log</h1>
          <p className="text-sm text-muted-foreground">Every privileged action and tenant-data view.</p>
        </div>
      </div>

      <div className="mt-4 flex gap-1.5">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            onClick={() => setFilter(f.value)}
            className={`rounded-lg px-3 py-1.5 text-sm ${filter === f.value ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:text-foreground"}`}
          >
            {f.label}
          </button>
        ))}
      </div>

      <Card className="mt-4 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
                <th className="px-4 py-2.5 font-medium">When</th>
                <th className="px-4 py-2.5 font-medium">Operator</th>
                <th className="px-4 py-2.5 font-medium">Action</th>
                <th className="px-4 py-2.5 font-medium">Target</th>
                <th className="px-4 py-2.5 font-medium">Reason</th>
              </tr>
            </thead>
            <tbody>
              {!entries ? (
                Array.from({ length: 8 }).map((_, i) => (
                  <tr key={i} className="border-b border-border/60"><td className="px-4 py-3" colSpan={5}><Skeleton className="h-5 w-full" /></td></tr>
                ))
              ) : entries.length === 0 ? (
                <tr><td className="px-4 py-8 text-center text-muted-foreground" colSpan={5}>No entries.</td></tr>
              ) : (
                entries.map((e) => (
                  <tr key={e.id} className="border-b border-border/60 last:border-0">
                    <td className="whitespace-nowrap px-4 py-3 text-muted-foreground" title={e.at}>{timeAgo(e.at)}</td>
                    <td className="px-4 py-3">{e.adminEmail}</td>
                    <td className="px-4 py-3"><Badge tone={actionTone(e.action)} size="sm"><span className="font-mono">{e.action}</span></Badge></td>
                    <td className="px-4 py-3">
                      {e.targetOrgId ? (
                        <Link href={`/admin/tenants/${e.targetOrgId}`} className="font-mono text-xs text-primary hover:underline">{e.targetOrgId.slice(0, 10)}…</Link>
                      ) : e.targetId ? (
                        <span className="font-mono text-xs text-muted-foreground">{e.targetId.slice(0, 14)}</span>
                      ) : "—"}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{e.reason ?? "—"}</td>
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
