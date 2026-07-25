"use client";

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, Building2, Users, FileText, RadioTower, Wallet, Plug } from "lucide-react";
import { formatMoney } from "@/lib/domain/money";
import { PLAN_BY_CODE, type PlanCode } from "@/lib/domain/billing";
import { formatDate } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/feedback";

interface Detail {
  org: { id: string; name: string; slug: string; status: string; suspendedReason: string | null; createdAt: string };
  members: { userId: string; email: string; name: string; role: string }[];
  entities: { id: string; legalNameEn: string; trn?: string; einvoicingStatus: string; currency: string }[];
  invoiceCount: number;
  transmissions: Record<string, number>;
  payments: { status: string; count: number; amountMinor: number }[];
  connections: { provider: string; status: string; mode?: string }[];
  apiKeys: number;
  integrationTokens: number;
  billing: { plan: PlanCode; usage: number; allowance: number; overage: number };
}

function Panel({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardContent className="p-5">
        <div className="flex items-center gap-2 text-muted-foreground">
          {icon}
          <h2 className="font-display text-sm font-semibold text-foreground">{title}</h2>
        </div>
        <div className="mt-3">{children}</div>
      </CardContent>
    </Card>
  );
}

export default function TenantDetailPage() {
  const { org } = useParams<{ org: string }>();
  const [d, setD] = React.useState<Detail | null>(null);
  const [notFound, setNotFound] = React.useState(false);

  React.useEffect(() => {
    fetch(`/api/admin/tenants/${org}`, { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then(setD)
      .catch(() => setNotFound(true));
  }, [org]);

  if (notFound) return <p className="text-sm text-muted-foreground">Workspace not found.</p>;
  if (!d) return <div className="space-y-3"><Skeleton className="h-10 w-64" /><Skeleton className="h-40 w-full" /></div>;

  return (
    <div>
      <Link href="/admin/tenants" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> Tenants
      </Link>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <div className="flex size-11 items-center justify-center rounded-xl bg-muted text-muted-foreground">
          <Building2 className="size-5" />
        </div>
        <div>
          <h1 className="flex items-center gap-2 font-display text-2xl font-bold tracking-tight">
            {d.org.name}
            <Badge tone={d.org.status === "active" ? "success" : d.org.status === "suspended" ? "warning" : "neutral"} size="sm">
              {d.org.status}
            </Badge>
          </h1>
          <p className="font-mono text-xs text-muted-foreground">{d.org.slug} · since {formatDate(d.org.createdAt)}</p>
        </div>
      </div>
      {d.org.suspendedReason && (
        <p className="mt-2 rounded-lg border border-warning/25 bg-warning/[0.06] px-3 py-2 text-sm text-muted-foreground">
          Suspended: {d.org.suspendedReason}
        </p>
      )}

      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        <Panel icon={<Wallet className="size-4" />} title="Billing & usage">
          <div className="flex items-center justify-between">
            <Badge tone={d.billing.plan === "FREE_MANDATE" ? "neutral" : "gold"}>{PLAN_BY_CODE[d.billing.plan].name}</Badge>
            <span className="text-sm tabular-nums">
              <span className={d.billing.overage > 0 ? "text-warning" : ""}>{d.billing.usage}</span>
              <span className="text-muted-foreground"> / {d.billing.allowance} exchanges</span>
            </span>
          </div>
          {d.billing.overage > 0 && <p className="mt-2 text-xs text-warning">{d.billing.overage} over allowance</p>}
        </Panel>

        <Panel icon={<FileText className="size-4" />} title="Compliance">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Invoices</span>
            <span className="tabular-nums font-medium">{d.invoiceCount}</span>
          </div>
          <div className="mt-2 space-y-1.5">
            {Object.entries(d.transmissions).length === 0 ? (
              <p className="text-xs text-muted-foreground">No transmissions.</p>
            ) : (
              Object.entries(d.transmissions).map(([k, v]) => (
                <div key={k} className="flex items-center justify-between text-xs">
                  <span className="font-mono text-muted-foreground">{k}</span>
                  <span className="tabular-nums">{v}</span>
                </div>
              ))
            )}
          </div>
        </Panel>

        <Panel icon={<Users className="size-4" />} title={`Members (${d.members.length})`}>
          <div className="space-y-2">
            {d.members.map((m) => (
              <div key={m.userId} className="flex items-center justify-between">
                <span className="truncate text-sm">{m.email}</span>
                <Badge tone="neutral" size="sm">{m.role}</Badge>
              </div>
            ))}
          </div>
        </Panel>

        <Panel icon={<Building2 className="size-4" />} title={`Entities (${d.entities.length})`}>
          <div className="space-y-2">
            {d.entities.length === 0 ? (
              <p className="text-xs text-muted-foreground">No entities.</p>
            ) : (
              d.entities.map((e) => (
                <div key={e.id} className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm">{e.legalNameEn}</p>
                    {e.trn && <p className="font-mono text-[11px] text-muted-foreground">TRN {e.trn}</p>}
                  </div>
                  <Badge tone={e.einvoicingStatus === "LIVE" ? "success" : "neutral"} size="sm">{e.einvoicingStatus}</Badge>
                </div>
              ))
            )}
          </div>
        </Panel>

        <Panel icon={<Wallet className="size-4" />} title="Payments">
          {d.payments.length === 0 ? (
            <p className="text-xs text-muted-foreground">No payments.</p>
          ) : (
            <div className="space-y-1.5">
              {d.payments.map((p) => (
                <div key={p.status} className="flex items-center justify-between text-sm">
                  <span className="font-mono text-xs text-muted-foreground">{p.status}</span>
                  <span className="tabular-nums">{p.count} · {formatMoney(p.amountMinor)}</span>
                </div>
              ))}
            </div>
          )}
        </Panel>

        <Panel icon={<Plug className="size-4" />} title="Integrations & keys">
          <div className="space-y-1.5 text-sm">
            <div className="flex items-center justify-between"><span className="text-muted-foreground">API keys</span><span className="tabular-nums">{d.apiKeys}</span></div>
            <div className="flex items-center justify-between"><span className="text-muted-foreground">OAuth tokens</span><span className="tabular-nums">{d.integrationTokens}</span></div>
            {d.connections.map((c, i) => (
              <div key={i} className="flex items-center justify-between">
                <span className="font-mono text-xs text-muted-foreground">{c.provider}</span>
                <Badge tone={c.status === "CONNECTED" ? "success" : "neutral"} size="sm">{c.mode ?? c.status}</Badge>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      <p className="mt-4 flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
        <RadioTower className="size-3.5" /> This view was logged to the audit trail.
      </p>
    </div>
  );
}
