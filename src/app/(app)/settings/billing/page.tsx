"use client";

import * as React from "react";
import { Check, Sparkles, Zap, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatMoney } from "@/lib/domain/money";
import { PLANS, type PlanCode } from "@/lib/domain/billing";
import { useAppState } from "@/lib/app-state";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/feedback";
import { toast } from "sonner";

interface Usage {
  used: number;
  included: number;
  plan: PlanCode;
  remaining: number;
  overage: number;
  year: number;
}

export default function BillingPage() {
  const { currentEntity } = useAppState();
  const [usage, setUsage] = React.useState<Usage | null>(null);
  const [plan, setPlan] = React.useState<PlanCode>("FREE_MANDATE");
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState<PlanCode | null>(null);

  const load = React.useCallback(async () => {
    if (!currentEntity) return;
    setLoading(true);
    try {
      const [u, p] = await Promise.all([
        fetch(`/api/usage?entityId=${encodeURIComponent(currentEntity.id)}`, { credentials: "same-origin" }).then((r) => r.json()),
        fetch(`/api/billing/plan`, { credentials: "same-origin" }).then((r) => r.json()),
      ]);
      setUsage(u);
      setPlan((p.plan as PlanCode) ?? "FREE_MANDATE");
    } catch {
      /* leave defaults */
    } finally {
      setLoading(false);
    }
  }, [currentEntity]);

  React.useEffect(() => {
    load();
  }, [load]);

  const choose = async (code: PlanCode, name: string) => {
    setSaving(code);
    try {
      const res = await fetch(`/api/billing/plan`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ plan: code }),
      });
      if (!res.ok) throw new Error();
      setPlan(code);
      toast.success(`Switched to ${name}`, { description: "Your allowance updated immediately." });
      load();
    } catch {
      toast.error("Couldn't change plan");
    } finally {
      setSaving(null);
    }
  };

  const used = usage?.used ?? 0;
  const included = usage?.included ?? 100;
  const pct = Math.min(100, included > 0 ? (used / included) * 100 : 0);
  const overage = usage?.overage ?? 0;

  return (
    <div className="max-w-4xl space-y-5">
      {/* Usage */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Sparkles className="size-4 text-gold" /> Exchanges this year
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <Skeleton className="h-16 w-full" />
          ) : (
            <>
              <div className="flex items-end justify-between">
                <p className="font-display text-3xl font-bold tnum">
                  {used}
                  <span className="text-lg font-medium text-muted-foreground"> / {included}</span>
                </p>
                <p className="text-sm text-muted-foreground">
                  {overage > 0 ? `${overage} over allowance` : `${included - used} left`}
                </p>
              </div>
              <div className="mt-3">
                <Progress value={pct} tone={overage > 0 ? "error" : pct > 90 ? "warning" : "gold"} />
              </div>
              {overage > 0 ? (
                <div className="mt-3 flex items-start gap-2.5 rounded-lg border border-warning/25 bg-warning/[0.06] p-3 text-sm">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
                  <span className="text-muted-foreground">
                    You're {overage} exchange{overage === 1 ? "" : "s"} over your plan allowance. Compliance
                    keeps working — MD 64 mandates it — but upgrading avoids overage charges at renewal.
                  </span>
                </div>
              ) : (
                <p className="mt-3 text-xs text-muted-foreground">
                  Every entity gets 100 free e-invoice exchanges + reporting per year, mandated by MD 64 —
                  applied before any plan charge. Compliance never stops for a billing issue.
                </p>
              )}
              <p className="mt-2 text-[11px] text-muted-foreground">
                Metered from {currentEntity?.legalNameEn ?? "this entity"}&apos;s successful transmissions in{" "}
                {usage?.year ?? new Date().getUTCFullYear()}.
              </p>
            </>
          )}
        </CardContent>
      </Card>

      {/* Plans */}
      <div>
        <h2 className="mb-3 font-display text-lg font-semibold">Plans</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {PLANS.map((p) => {
            const active = plan === p.code;
            return (
              <Card
                key={p.code}
                className={cn(
                  "flex flex-col p-5 transition-all hover-lift",
                  active && "border-gold ring-1 ring-gold/30",
                )}
              >
                <div className="flex items-center justify-between">
                  <h3 className="font-display font-semibold">{p.name}</h3>
                  {active && <Badge tone="gold" size="sm">Current</Badge>}
                </div>
                <p className="mt-2 font-display text-2xl font-bold tnum">
                  {p.priceMinor === 0 ? "Free" : formatMoney(p.priceMinor)}
                  {p.priceMinor > 0 && <span className="text-sm font-medium text-muted-foreground">/yr</span>}
                </p>
                <ul className="mt-4 flex-1 space-y-2">
                  {p.features.map((f) => (
                    <li key={f} className="flex items-start gap-2 text-sm">
                      <Check className="mt-0.5 size-4 shrink-0 text-success" />
                      <span className="text-muted-foreground">{f}</span>
                    </li>
                  ))}
                </ul>
                <Button
                  className="mt-4 w-full"
                  variant={active ? "outline" : "primary"}
                  disabled={active || saving !== null}
                  loading={saving === p.code}
                  onClick={() => choose(p.code, p.name)}
                >
                  {active ? "Current plan" : "Choose plan"}
                </Button>
              </Card>
            );
          })}
        </div>
      </div>

      <Card>
        <CardContent className="flex items-center gap-3 p-4">
          <Zap className="size-5 text-info" />
          <p className="text-sm text-muted-foreground">
            Payment is handled by our billing provider. In this environment, plan changes are recorded
            for your workspace — no card is charged.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
