"use client";

import * as React from "react";
import Link from "next/link";
import { Building2, FileText, RadioTower, Wallet, TrendingUp, Users, ArrowRight } from "lucide-react";
import { formatMoneyCompact } from "@/lib/domain/money";
import { PLAN_BY_CODE, type PlanCode } from "@/lib/domain/billing";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/feedback";

interface Overview {
  counts: { orgs: number; users: number; entities: number; invoices: number; transmissions: number; payments: number };
  signups: { last7: number; last30: number };
  transmissions: { total: number; successRate: number; failures: number; delivered: number; exchange: Record<string, number>; reporting: Record<string, number> };
  payments: { status: Record<string, number>; volume: { currency: string; amountMinor: number; count: number }[] };
  revenue: { distribution: Record<PlanCode, number>; arrMinor: number; mrrMinor: number };
}

function Stat({ icon, label, value, sub, tone }: { icon: React.ReactNode; label: string; value: React.ReactNode; sub?: string; tone?: "good" | "warn" }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center gap-2 text-muted-foreground">
          <span className="text-muted-foreground">{icon}</span>
          <span className="font-mono text-[11px] uppercase tracking-wider">{label}</span>
        </div>
        <p className={`mt-2 font-display text-2xl font-bold tabular-nums ${tone === "good" ? "text-success" : tone === "warn" ? "text-warning" : ""}`}>{value}</p>
        {sub && <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>}
      </CardContent>
    </Card>
  );
}

export default function AdminOverview() {
  const [data, setData] = React.useState<Overview | null>(null);
  React.useEffect(() => {
    fetch("/api/admin/overview", { credentials: "same-origin" })
      .then((r) => r.json())
      .then(setData)
      .catch(() => {});
  }, []);

  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight">Overview</h1>
          <p className="text-sm text-muted-foreground">Everything happening across the platform, right now.</p>
        </div>
        <Link href="/admin/tenants" className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline">
          All tenants <ArrowRight className="size-4" />
        </Link>
      </div>

      {!data ? (
        <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-24 w-full" />)}
        </div>
      ) : (
        <>
          <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat icon={<Building2 className="size-4" />} label="Tenants" value={data.counts.orgs} sub={`+${data.signups.last7} this week · +${data.signups.last30} / 30d`} />
            <Stat icon={<Users className="size-4" />} label="Users" value={data.counts.users} sub={`${data.counts.entities} entities`} />
            <Stat icon={<FileText className="size-4" />} label="Invoices" value={data.counts.invoices} sub={`${data.counts.transmissions} transmitted`} />
            <Stat icon={<RadioTower className="size-4" />} label="Send success" value={`${data.transmissions.successRate}%`} sub={`${data.transmissions.failures} failures`} tone={data.transmissions.successRate >= 95 ? "good" : "warn"} />
            <Stat icon={<TrendingUp className="size-4" />} label="MRR" value={formatMoneyCompact(data.revenue.mrrMinor)} sub={`${formatMoneyCompact(data.revenue.arrMinor)} ARR`} />
            <Stat icon={<Wallet className="size-4" />} label="Payments" value={data.counts.payments} sub={`${data.payments.status.PAID ?? 0} paid`} />
            <Stat icon={<RadioTower className="size-4" />} label="Delivered" value={data.transmissions.delivered} sub={`of ${data.transmissions.total} sends`} />
            <Stat icon={<Building2 className="size-4" />} label="Paid plans" value={data.revenue.distribution.STARTER + data.revenue.distribution.GROWTH + data.revenue.distribution.SCALE} sub={`${data.revenue.distribution.FREE_MANDATE} free`} />
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            {/* Transmission health */}
            <Card>
              <CardContent className="p-5">
                <h2 className="font-display font-semibold">Deliverability</h2>
                <div className="mt-3 space-y-2">
                  {Object.entries(data.transmissions.exchange).length === 0 ? (
                    <p className="text-sm text-muted-foreground">No transmissions yet.</p>
                  ) : (
                    Object.entries(data.transmissions.exchange).map(([k, v]) => (
                      <div key={k} className="flex items-center justify-between text-sm">
                        <span className="font-mono text-xs text-muted-foreground">{k}</span>
                        <span className="tabular-nums font-medium">{v}</span>
                      </div>
                    ))
                  )}
                </div>
              </CardContent>
            </Card>

            {/* Plan mix */}
            <Card>
              <CardContent className="p-5">
                <h2 className="font-display font-semibold">Plan mix</h2>
                <div className="mt-3 space-y-2">
                  {(Object.keys(data.revenue.distribution) as PlanCode[]).map((code) => (
                    <div key={code} className="flex items-center justify-between text-sm">
                      <span className="flex items-center gap-2">
                        <Badge tone={code === "FREE_MANDATE" ? "neutral" : "gold"} size="sm">{PLAN_BY_CODE[code].name}</Badge>
                      </span>
                      <span className="tabular-nums font-medium">{data.revenue.distribution[code]}</span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
