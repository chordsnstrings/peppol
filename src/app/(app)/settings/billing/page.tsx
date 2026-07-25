"use client";

import * as React from "react";
import { Check, Sparkles, Zap, AlertTriangle, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatMoney } from "@/lib/domain/money";
import type { SubTier } from "@/lib/domain/billing";
import { getSubscription, startCheckout, type SubscriptionState } from "@/lib/subscription-client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/feedback";
import { toast } from "sonner";

interface Tier {
  tier: SubTier;
  name: string;
  priceMinor: number;
  months: number;
  perMonthMinor: number;
  savingsPct: number;
  highlight?: boolean;
}

function daysLeft(iso: string | null): number | null {
  if (!iso) return null;
  return Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000));
}

const FEATURES = [
  "Unlimited invoices & FTA transmission",
  "PINT AE UBL + Tax Data Document",
  "Every integration (Zoho, QBO, Xero, Odoo, Shopify, Woo)",
  "WhatsApp, payment links & AR",
  "Public API + MCP (connect your AI)",
  "Full audit-grade evidence bundles",
];

export default function BillingPage() {
  const [sub, setSub] = React.useState<SubscriptionState | null>(null);
  const [tiers, setTiers] = React.useState<Tier[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState<SubTier | null>(null);

  const load = React.useCallback(async () => {
    try {
      const { subscription, tiers } = await getSubscription();
      setSub(subscription);
      setTiers(tiers as Tier[]);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    load();
  }, [load]);

  const checkout = async (tier: SubTier) => {
    setBusy(tier);
    try {
      const url = await startCheckout(tier);
      window.location.href = url; // hosted payment page → returns to /settings/billing
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't start checkout");
      setBusy(null);
    }
  };

  const status = sub?.status;
  const trialDays = daysLeft(sub?.trialEndsAt ?? null);
  const periodDays = daysLeft(sub?.currentPeriodEnd ?? null);
  const graceDays = daysLeft(sub?.graceEndsAt ?? null);

  return (
    <div className="max-w-4xl space-y-5">
      {/* Status */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="size-4 text-gold" /> Subscription
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <Skeleton className="h-14 w-full" />
          ) : status === "active" ? (
            <div className="flex flex-wrap items-center gap-3">
              <Badge tone="success" dot>
                Active
              </Badge>
              <p className="text-sm text-muted-foreground">
                {sub?.tier} plan · renews in {periodDays} day{periodDays === 1 ? "" : "s"}. You can transmit to
                the FTA without limits.
              </p>
            </div>
          ) : status === "trialing" && sub?.entitled ? (
            <div className="flex items-start gap-2.5 rounded-lg border border-info/25 bg-info/[0.06] p-3 text-sm">
              <Sparkles className="mt-0.5 size-4 shrink-0 text-info" />
              <span className="text-muted-foreground">
                <span className="font-medium text-foreground">Free trial</span> — {trialDays} day
                {trialDays === 1 ? "" : "s"} left. Subscribe before it ends to keep your FTA link live.
              </span>
            </div>
          ) : status === "grace" && sub?.entitled ? (
            <div className="flex items-start gap-2.5 rounded-lg border border-warning/25 bg-warning/[0.06] p-3 text-sm">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
              <span className="text-muted-foreground">
                <span className="font-medium text-foreground">Payment needed</span> — your plan lapsed.{" "}
                {graceDays} day{graceDays === 1 ? "" : "s"} of grace left before transmission is paused. Renew
                below.
              </span>
            </div>
          ) : (
            <div className="flex items-start gap-2.5 rounded-lg border border-destructive/25 bg-destructive/[0.06] p-3 text-sm">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
              <span className="text-muted-foreground">
                <span className="font-medium text-foreground">Transmission paused.</span> Subscribe to send
                invoices to the FTA again. Your data stays safe and exportable.
              </span>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Plans */}
      <div>
        <h2 className="mb-1 font-display text-lg font-semibold">Choose a plan</h2>
        <p className="mb-3 text-sm text-muted-foreground">
          Unlimited invoicing on every plan. Pay monthly, or save up to a third by paying ahead.
        </p>
        <div className="grid gap-3 sm:grid-cols-3">
          {tiers.map((t) => {
            const isCurrent = status === "active" && sub?.tier === t.tier;
            return (
              <Card
                key={t.tier}
                className={cn("relative flex flex-col p-5 transition-all hover-lift", t.highlight && "border-gold ring-1 ring-gold/30")}
              >
                {t.highlight && (
                  <span className="absolute -top-2.5 left-5 rounded-full bg-gold px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">
                    Best value
                  </span>
                )}
                <h3 className="font-display font-semibold">{t.name}</h3>
                <p className="mt-2 font-display text-2xl font-bold tnum">
                  {formatMoney(t.priceMinor)}
                  <span className="text-sm font-medium text-muted-foreground">
                    {t.months === 1 ? "/mo" : ` / ${t.months} mo`}
                  </span>
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {t.months === 1 ? "Billed monthly" : `${formatMoney(t.perMonthMinor)}/mo effective`}
                  {t.savingsPct > 0 ? ` · save ${t.savingsPct}%` : ""}
                </p>
                <div className="mt-4 flex-1" />
                <Button
                  className="w-full"
                  variant={t.highlight ? "primary" : "outline"}
                  disabled={isCurrent}
                  loading={busy === t.tier}
                  onClick={() => checkout(t.tier)}
                >
                  {isCurrent ? "Current plan" : status === "active" ? "Switch" : "Subscribe"}
                </Button>
              </Card>
            );
          })}
        </div>
      </div>

      {/* What's included */}
      <Card>
        <CardContent className="p-5">
          <h3 className="font-display font-semibold">Every plan includes</h3>
          <ul className="mt-3 grid gap-2 sm:grid-cols-2">
            {FEATURES.map((f) => (
              <li key={f} className="flex items-start gap-2 text-sm">
                <Check className="mt-0.5 size-4 shrink-0 text-success" />
                <span className="text-muted-foreground">{f}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex items-center gap-3 p-4">
          <Zap className="size-5 text-info" />
          <p className="text-sm text-muted-foreground">
            Prices are VAT-inclusive (5%); we issue you a tax invoice for each charge. Cancel anytime — your
            plan runs to the end of the paid period.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
