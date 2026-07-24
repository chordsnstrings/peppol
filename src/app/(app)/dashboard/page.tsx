"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  FileText,
  Send,
  CheckCircle2,
  AlertTriangle,
  Plus,
  ArrowRight,
  Sparkles,
  Wrench,
  Upload,
  Plug,
  Clock,
  ShieldCheck,
} from "lucide-react";
import { cn, formatDate, timeAgo } from "@/lib/utils";
import { formatMoney } from "@/lib/domain/money";
import { useAppState } from "@/lib/app-state";
import { useInvoices } from "@/hooks/use-entity-data";
import { deriveFixits } from "@/lib/fixit";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatCard } from "@/components/ui/stat";
import { Ring, Progress } from "@/components/ui/progress";
import { EmptyState } from "@/components/ui/empty-state";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/feedback";
import { Stagger, StaggerItem } from "@/components/motion/reveal";
import { AnimatedNumber } from "@/components/motion/animated-number";
import { BarChart } from "@/components/charts/mini-chart";
import { InvoiceStatus } from "@/components/invoice/status";
import { ActivationCard } from "./activation-card";

export default function DashboardPage() {
  const { currentEntity } = useAppState();
  const { invoices, loading } = useInvoices();
  const router = useRouter();

  const outbound = invoices.filter((i) => i.direction === "OUTBOUND");
  const thisMonth = outbound.filter(
    (i) => i.createdAt.slice(0, 7) === new Date().toISOString().slice(0, 7),
  );
  const completed = outbound.filter((i) => i.lifecycleStatus === "COMPLETED");
  const inTransit = outbound.filter((i) =>
    ["QUEUED", "SENDING", "SENT", "DELIVERED"].includes(i.lifecycleStatus),
  );
  const failed = outbound.filter((i) => i.lifecycleStatus === "FAILED");
  const drafts = outbound.filter((i) => i.lifecycleStatus === "DRAFT");
  const fixits = deriveFixits(invoices);
  const revenue = completed.reduce((s, i) => s + i.totals.taxInclusiveMinor, 0);

  const freeUsed = completed.length;
  const freePct = Math.min(100, (freeUsed / 100) * 100);

  // 14-day activity buckets (real)
  const buckets = React.useMemo(() => {
    const days: { label: string; value: number }[] = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      const count = outbound.filter((inv) => inv.createdAt.slice(0, 10) === key).length;
      days.push({ label: d.getDate().toString(), value: count });
    }
    return days;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoices]);

  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";

  if (loading) return <DashboardSkeleton />;

  const empty = outbound.length === 0;

  return (
    <div>
      <PageHeader
        title={
          <span>
            {greeting}
            <span className="text-muted-foreground"> · </span>
            <span className="text-gold-gradient">{currentEntity?.legalNameEn}</span>
          </span>
        }
        description="Here's where your compliance stands today."
        actions={
          <>
            <Button variant="outline" icon={<Upload />} onClick={() => router.push("/uploads")}>
              Import
            </Button>
            <Button icon={<Plus />} onClick={() => router.push("/invoices/new")}>
              New invoice
            </Button>
          </>
        }
      />

      {currentEntity && <ActivationCard entity={currentEntity} sentCount={completed.length} />}

      {empty ? (
        <EmptyState
          className="mt-6"
          icon={<FileText />}
          title="Your first invoice is a few clicks away"
          description="Create one in the editor, import an Excel sheet, or connect your accounting software. Everything you make is validated and archived for you."
          action={
            <Button icon={<Plus />} onClick={() => router.push("/invoices/new")}>
              Create invoice
            </Button>
          }
          secondaryAction={
            <Button variant="outline" icon={<Upload />} onClick={() => router.push("/uploads")}>
              Import a spreadsheet
            </Button>
          }
        />
      ) : (
        <>
          {/* KPIs */}
          <Stagger className="mt-6 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
            <StaggerItem>
              <StatCard
                label="Created this month"
                value={thisMonth.length}
                icon={<FileText />}
                hint={`${drafts.length} in draft`}
              />
            </StaggerItem>
            <StaggerItem>
              <StatCard
                label="In transit"
                value={inTransit.length}
                icon={<Send />}
                tone="info"
                hint="Exchange + reporting"
              />
            </StaggerItem>
            <StaggerItem>
              <StatCard
                label="Completed"
                value={completed.length}
                icon={<CheckCircle2 />}
                tone="success"
                hint="Delivered & reported"
              />
            </StaggerItem>
            <StaggerItem>
              <StatCard
                label="Need attention"
                value={fixits.length}
                icon={<AlertTriangle />}
                tone={fixits.length ? "warning" : "default"}
                hint={failed.length ? `${failed.length} failed` : "All clear"}
              />
            </StaggerItem>
          </Stagger>

          <div className="mt-4 grid gap-4 lg:grid-cols-3">
            {/* Activity chart */}
            <Card className="lg:col-span-2">
              <CardHeader className="flex-row items-center justify-between">
                <div>
                  <CardTitle>Invoice activity</CardTitle>
                  <p className="text-sm text-muted-foreground">Last 14 days</p>
                </div>
                <div className="text-end">
                  <p className="font-display text-2xl font-semibold tnum">
                    {formatMoney(revenue, currentEntity?.defaultCurrency)}
                  </p>
                  <p className="text-xs text-muted-foreground">Completed value</p>
                </div>
              </CardHeader>
              <CardContent>
                <BarChart data={buckets} height={150} />
              </CardContent>
            </Card>

            {/* Free allowance meter */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Sparkles className="size-4 text-gold" /> Free allowance
                </CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col items-center">
                <Ring value={freePct} size={132} stroke={11}>
                  <div className="text-center">
                    <p className="font-display text-3xl font-bold tnum">
                      <AnimatedNumber value={freeUsed} />
                    </p>
                    <p className="text-xs text-muted-foreground">of 100 used</p>
                  </div>
                </Ring>
                <p className="mt-4 text-center text-xs text-muted-foreground">
                  Every entity gets 100 free e-invoice exchanges per year — mandated by MD 64.
                </p>
              </CardContent>
            </Card>
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-3">
            {/* Fix-it summary */}
            <Card className="lg:col-span-1">
              <CardHeader className="flex-row items-center justify-between">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Wrench className="size-4" /> Fix-it queue
                </CardTitle>
                {fixits.length > 0 && (
                  <Badge tone="warning" size="sm">
                    {fixits.length} open
                  </Badge>
                )}
              </CardHeader>
              <CardContent className="space-y-2">
                {fixits.length === 0 ? (
                  <div className="flex flex-col items-center py-6 text-center">
                    <ShieldCheck className="size-8 text-success" />
                    <p className="mt-2 text-sm font-medium">Nothing needs fixing</p>
                    <p className="text-xs text-muted-foreground">You're fully compliant.</p>
                  </div>
                ) : (
                  <>
                    {fixits.slice(0, 3).map((f) => (
                      <Link
                        key={f.id}
                        href={f.ref ? `/invoices/${f.ref}` : "/fixit"}
                        className="flex items-start gap-2.5 rounded-lg p-2 transition-colors hover:bg-accent"
                      >
                        <span
                          className={cn(
                            "mt-0.5 flex size-6 items-center justify-center rounded-md",
                            f.severity === "ERROR"
                              ? "bg-destructive/10 text-destructive"
                              : "bg-warning/10 text-[hsl(var(--warning))]",
                          )}
                        >
                          {f.severity === "ERROR" ? (
                            <AlertTriangle className="size-3.5" />
                          ) : (
                            <Clock className="size-3.5" />
                          )}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">{f.title}</span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {f.body}
                          </span>
                        </span>
                      </Link>
                    ))}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="w-full"
                      onClick={() => router.push("/fixit")}
                    >
                      View all <ArrowRight className="size-4 rtl:rotate-180" />
                    </Button>
                  </>
                )}
              </CardContent>
            </Card>

            {/* Recent activity */}
            <Card className="lg:col-span-2">
              <CardHeader className="flex-row items-center justify-between">
                <CardTitle className="text-base">Recent invoices</CardTitle>
                <Link
                  href="/invoices"
                  className="text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
                >
                  View all
                </Link>
              </CardHeader>
              <CardContent className="divide-y divide-border">
                {outbound.slice(0, 5).map((inv) => (
                  <Link
                    key={inv.id}
                    href={`/invoices/${inv.id}`}
                    className="-mx-2 flex items-center gap-3 rounded-lg px-2 py-3 transition-colors hover:bg-accent"
                  >
                    <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                      <FileText className="size-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">
                        {inv.number || "Untitled draft"}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {inv.buyer.nameEn || "No customer"} · {timeAgo(inv.updatedAt)}
                      </p>
                    </div>
                    <div className="text-end">
                      <p className="text-sm font-semibold tnum">
                        {formatMoney(inv.totals.taxInclusiveMinor, inv.currency)}
                      </p>
                      <InvoiceStatus invoice={inv} size="sm" />
                    </div>
                  </Link>
                ))}
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <div>
      <Skeleton className="h-9 w-64" />
      <Skeleton className="mt-2 h-5 w-80" />
      <div className="mt-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-32 rounded-2xl" />
        ))}
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Skeleton className="h-64 rounded-2xl lg:col-span-2" />
        <Skeleton className="h-64 rounded-2xl" />
      </div>
    </div>
  );
}
