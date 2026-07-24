"use client";

import * as React from "react";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";

export function Progress({
  value,
  className,
  tone = "gold",
  animated = true,
}: {
  value: number;
  className?: string;
  tone?: "gold" | "success" | "info" | "warning" | "error" | "primary";
  animated?: boolean;
}) {
  const toneMap: Record<string, string> = {
    gold: "bg-gold",
    success: "bg-success",
    info: "bg-info",
    warning: "bg-warning",
    error: "bg-destructive",
    primary: "bg-primary",
  };
  return (
    <div className={cn("h-2 w-full overflow-hidden rounded-full bg-muted", className)}>
      <motion.div
        className={cn("h-full rounded-full", toneMap[tone])}
        initial={animated ? { width: 0 } : false}
        animate={{ width: `${Math.min(100, Math.max(0, value))}%` }}
        transition={{ type: "spring", stiffness: 120, damping: 22 }}
      />
    </div>
  );
}

/** Circular meter used for allowance / compliance rings. */
export function Ring({
  value,
  size = 88,
  stroke = 8,
  tone = "hsl(var(--gold))",
  track = "hsl(var(--muted))",
  children,
  className,
}: {
  value: number;
  size?: number;
  stroke?: number;
  tone?: string;
  track?: string;
  children?: React.ReactNode;
  className?: string;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = Math.min(100, Math.max(0, value));
  const offset = c - (pct / 100) * c;
  return (
    <div className={cn("relative inline-flex items-center justify-center", className)} style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={track} strokeWidth={stroke} />
        <motion.circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={tone}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          initial={{ strokeDashoffset: c }}
          animate={{ strokeDashoffset: offset }}
          transition={{ type: "spring", stiffness: 90, damping: 20, delay: 0.1 }}
        />
      </svg>
      {children && <div className="absolute inset-0 flex items-center justify-center">{children}</div>}
    </div>
  );
}
