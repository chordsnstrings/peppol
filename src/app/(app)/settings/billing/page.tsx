"use client";

import * as React from "react";
import { Check, Sparkles, Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatMoney } from "@/lib/domain/money";
import { useAppState } from "@/lib/app-state";
import { useInvoices } from "@/hooks/use-entity-data";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { toast } from "sonner";

const PLANS = [
  { code: "FREE_MANDATE", name: "Free mandate", price: 0, included: 100, features: ["100 exchanges / entity / yr", "All compliance features", "Email support"] },
  { code: "STARTER", name: "Starter", price: 240000, included: 600, features: ["600 exchanges / yr", "Excel importer", "2 integrations"] },
  { code: "GROWTH", name: "Growth", price: 600000, included: 2400, features: ["2,400 exchanges / yr", "All integrations", "Priority support", "API access"] },
  { code: "SCALE", name: "Scale", price: 1500000, included: 12000, features: ["12,000 exchanges / yr", "Multi-entity", "SLA & onboarding"] },
];

export default function BillingPage() {
  const { currentEntity } = useAppState();
  const { invoices } = useInvoices((i) => i.direction === "OUTBOUND" && i.lifecycleStatus === "COMPLETED");
  const [current, setCurrent] = React.useState("FREE_MANDATE");
  const used = invoices.length;
  const pct = Math.min(100, (used / 100) * 100);

  return (
    <div className="max-w-4xl space-y-5">
      {/* Usage */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Sparkles className="size-4 text-gold" /> Free allowance this year
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-end justify-between">
            <p className="font-display text-3xl font-bold tnum">
              {used}
              <span className="text-lg font-medium text-muted-foreground"> / 100</span>
            </p>
            <p className="text-sm text-muted-foreground">
              {100 - used} free exchanges left
            </p>
          </div>
          <div className="mt-3">
            <Progress value={pct} tone={pct > 90 ? "warning" : "gold"} />
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            Every entity gets 100 free e-invoice exchanges + reporting per year, mandated by MD 64 —
            applied before any plan charge. Compliance never stops for a billing issue.
          </p>
        </CardContent>
      </Card>

      {/* Plans */}
      <div>
        <h2 className="mb-3 font-display text-lg font-semibold">Plans</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {PLANS.map((p) => {
            const active = current === p.code;
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
                  {p.price === 0 ? "Free" : formatMoney(p.price)}
                  {p.price > 0 && <span className="text-sm font-medium text-muted-foreground">/yr</span>}
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
                  disabled={active}
                  onClick={() => {
                    setCurrent(p.code);
                    toast.success(`Switched to ${p.name}`, { description: "Effective next billing cycle." });
                  }}
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
            locally — no card is charged.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
