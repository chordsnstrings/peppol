"use client";

import * as React from "react";
import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { AnimatedNumber } from "@/components/motion/animated-number";
import { Card } from "./card";

export function StatCard({
  label,
  value,
  format,
  icon,
  trend,
  hint,
  tone = "default",
  className,
}: {
  label: string;
  value: number;
  format?: (n: number) => string;
  icon?: React.ReactNode;
  trend?: { value: number; label?: string };
  hint?: string;
  tone?: "default" | "gold" | "success" | "info" | "warning";
  className?: string;
}) {
  const toneRing: Record<string, string> = {
    default: "text-muted-foreground bg-muted",
    gold: "text-[hsl(var(--gold))] bg-gold/10",
    success: "text-success bg-success/10",
    info: "text-info bg-info/10",
    warning: "text-[hsl(var(--warning))] bg-warning/10",
  };
  return (
    <Card className={cn("group relative overflow-hidden p-5 hover-lift", className)}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-muted-foreground">{label}</p>
          <p className="mt-2 font-display text-[26px] font-semibold tracking-tight tnum">
            <AnimatedNumber value={value} format={format} />
          </p>
        </div>
        {icon && (
          <div
            className={cn(
              "flex size-10 items-center justify-center rounded-xl [&_svg]:size-5",
              toneRing[tone],
            )}
          >
            {icon}
          </div>
        )}
      </div>
      <div className="mt-3 flex items-center gap-2 text-xs">
        {trend && (
          <span
            className={cn(
              "inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 font-medium",
              trend.value >= 0 ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive",
            )}
          >
            {trend.value >= 0 ? (
              <ArrowUpRight className="size-3" />
            ) : (
              <ArrowDownRight className="size-3" />
            )}
            {Math.abs(trend.value)}%
          </span>
        )}
        {(trend?.label || hint) && (
          <span className="truncate text-muted-foreground">{trend?.label ?? hint}</span>
        )}
      </div>
      <div className="pointer-events-none absolute -right-6 -top-6 size-24 rounded-full bg-gold/5 opacity-0 blur-2xl transition-opacity duration-500 group-hover:opacity-100" />
    </Card>
  );
}
